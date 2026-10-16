'use strict';
/* Second half of the node catalogue: loops, the Claude agent, chat, data tables, polling triggers
   (RSS, Telegram, folder watch) and text/markup nodes. Merged into NODES by nodes.js. */
const fs = require('fs');
const path = require('path');
const Expr = require('./expr');
const M = require('./markup');
const store = require('./store');

module.exports = function extraNodes(h) {
  const { httpRequest, toItems, parseJSON, isObj, clone, getPath, setPath, kvObject, safeFile, MODELS } = h;
  const str = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const slug = s => String(s).toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  /* ---------- Claude helpers shared by the agent ---------- */
  function sdk() {
    try { const A = require('@anthropic-ai/sdk'); return A.default || A; }
    catch { throw new Error('Anthropic SDK kurulu değil. Program klasöründe "npm install" çalıştırın.'); }
  }
  async function claudeCall(Anthropic, client, params, signal) {
    const fallbackOK = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'].includes(params.model);
    try {
      return await client.beta.messages.create({ ...params, ...(fallbackOK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}) }, { signal });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API anahtarı geçersiz');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic hız sınırına takıldı; biraz sonra tekrar deneyin ya da node seçeneklerinden yeniden denemeyi açın');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API hatası (${e.status ?? 'ağ'}): ${e.message}`);
      throw e;
    }
  }
  const cut = (v, n = 20000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}… (${s.length - n} karakter daha kesildi)` : s; };

  /* polling triggers: `poll(ctx)` is called by the server on an interval while the workflow is active.
     It returns the new items (or nothing). `run` handles both a real fire and an editor test run. */
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];

  const NODES = {
    /* ===== flow ===== */
    loop: {
      label: 'Döngü (parça parça işle)', cat: 'flow', icon: 'loop', inputs: 1, outputs: ['bitti', 'döngü'],
      desc: 'Öğeleri parçalara bölüp "döngü" çıkışından sırayla gönderir. Döngüdeki son node\'u tekrar bu node\'un girişine bağlayın. Hepsi bitince geri gelen öğeler "bitti" çıkışından çıkar.',
      params: [
        { key: 'batchSize', label: 'Her turda kaç öğe', type: 'number', def: 1, min: 1 },
        { key: 'maxIterations', label: 'En fazla tur (güvenlik sınırı)', type: 'number', def: 10000, min: 1 },
      ],
      sub: 'her turda {batchSize}',
      async run(c) { return [c.items, []]; }, // the engine runs loops itself
    },
    newItems: {
      label: 'Yeni öğeleri bul', cat: 'flow', icon: 'sparkle', inputs: 1, outputs: ['yeni', 'görülmüş'],
      desc: 'Önceki çalıştırmalarda hiç görülmemiş öğeleri "yeni" çıkışından geçirir. Zamanlayıcı ile her seferinde yalnızca yeni kayıtları işlemek için.',
      params: [
        { key: 'key', label: 'Öğeyi tanıyan değer', type: 'expr', def: '{{ $json.id }}' },
        { key: 'keep', label: 'Hatırlanacak en fazla kayıt', type: 'number', def: 10000, min: 10 },
        { key: 'editorDry', label: 'Editör çalıştırmalarında hafızayı güncelleme', type: 'toggle', def: true },
      ],
      sub: '{key}',
      async run(c) {
        const mem = c.memory(); const seen = new Set(mem.seen || []);
        const fresh = [], old = [];
        c.items.forEach((it, i) => { const k = str(c.R(c.p.key, it, i)); if (seen.has(k)) old.push(it); else { fresh.push(it); seen.add(k); } });
        const dry = c.p.editorDry && ['manuel', 'node testi'].includes(c.mode);
        if (!dry && fresh.length) { mem.seen = [...seen].slice(-(Number(c.p.keep) || 10000)); c.saveMemory(); }
        c.log(`${fresh.length} yeni, ${old.length} daha önce görülmüş${dry ? ' (editör çalıştırması: hafıza güncellenmedi)' : ''}`);
        return [fresh, old];
      },
    },

    /* ===== AI ===== */
    agent: {
      label: 'Claude ajanı (araçlı)', cat: 'ai', icon: 'robot', inputs: 1, outputs: ['main'],
      desc: 'Claude\'a bir görev verir; Claude gerekirse araçları (web isteği, hesap makinesi, veri tabloları, seçtiğiniz akışlar) kendisi kullanarak sonuca ulaşır. Sohbet hafızası açılırsa aynı oturumdaki önceki mesajları hatırlar.',
      params: [
        { key: 'credential', label: 'Anthropic API anahtarı', type: 'credential', credTypes: ['anthropicApi'], def: '' },
        { key: 'model', label: 'Model', type: 'select', def: 'claude-opus-5-5', options: MODELS },
        { key: 'effort', label: 'Düşünme çabası', type: 'select', def: 'medium', options: [['low', 'Düşük (hızlı, ucuz)'], ['medium', 'Orta'], ['high', 'Yüksek'], ['xhigh', 'Çok yüksek'], ['max', 'En yüksek']] },
        { key: 'system', label: 'Görev tanımı (sistem talimatı)', type: 'textarea', def: 'Sen yardımsever bir asistansın. Türkçe, kısa ve net yanıt ver. Bilmediğin bir şeyi araçlarla öğren, uydurma.' },
        { key: 'prompt', label: 'Kullanıcı mesajı', type: 'textarea', def: '{{ $json.mesaj }}' },
        { key: 'toolHttp', label: 'Araç: web sayfası / API isteği', type: 'toggle', def: true },
        { key: 'toolCalc', label: 'Araç: hesap makinesi', type: 'toggle', def: true },
        { key: 'toolTime', label: 'Araç: şu anki tarih ve saat', type: 'toggle', def: true },
        { key: 'toolTables', label: 'Araç: veri tablolarını oku/yaz', type: 'toggle', def: false },
        { key: 'workflows', label: 'Araç olarak kullanılacak akışlar', type: 'wftools', def: [], help: 'Her akış "Alt akış girişi" ile başlamalı. Claude, açıklamaya bakarak ne zaman çağıracağına karar verir.' },
        { key: 'memory', label: 'Sohbet hafızası', type: 'toggle', def: false },
        { key: 'session', label: 'Oturum kimliği', type: 'expr', def: '{{ $json.oturum }}', showIf: { memory: true }, help: 'Aynı kimlikli mesajlar aynı sohbetin devamı sayılır.' },
        { key: 'memorySize', label: 'Hatırlanacak mesaj sayısı', type: 'number', def: 20, min: 2, showIf: { memory: true } },
        { key: 'maxSteps', label: 'En fazla araç adımı', type: 'number', def: 10, min: 1 },
        { key: 'output', label: 'Yanıt alanı', type: 'text', def: 'yanit' },
      ],
      sub: '{model}',
      async run(c) {
        const Anthropic = sdk();
        const cred = await c.credential(c.p.credential);
        const client = new Anthropic({ apiKey: cred.data.apiKey });
        const tools = [], impl = {};
        const tool = (name, description, properties, required, fn) => { tools.push({ name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } }); impl[name] = fn; };
        if (c.p.toolHttp) tool('web_istegi', 'Bir web sayfasını ya da API adresini çağırır. HTML sayfalarda okunabilir metin, JSON yanıtlarda veri döner.', {
          url: { type: 'string', description: 'Tam adres (https://…)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Varsayılan GET' },
          body: { type: 'string', description: 'POST/PUT için JSON gövde (metin olarak)' },
        }, ['url'], async a => {
          const r = await httpRequest({ method: a.method || 'GET', url: a.url, headers: a.body ? { 'Content-Type': 'application/json' } : {}, body: a.body, signal: c.signal });
          let body = r.body;
          if (typeof body === 'string' && /<html|<body|<!doctype/i.test(body.slice(0, 500))) { const root = M.parseHTML(body); body = M.cleanText(M.textOf(root, { pretty: true })); }
          return { durum: r.status, govde: cut(body, 15000) };
        });
        if (c.p.toolCalc) tool('hesap_makinesi', 'Matematik ifadesini hesaplar. Math fonksiyonları kullanılabilir: Math.sqrt(2), 15 * 1.2, Math.round(3.7)', { ifade: { type: 'string' } }, ['ifade'],
          async a => ({ sonuc: Expr.render(`{{ ${a.ifade} }}`, Expr.makeScope({})) }));
        if (c.p.toolTime) tool('simdiki_zaman', 'Şu anki tarih ve saati verir.', {}, [], async () => ({ iso: new Date().toISOString(), yerel: new Date().toLocaleString('tr-TR'), gun: new Date().toLocaleDateString('tr-TR', { weekday: 'long' }) }));
        if (c.p.toolTables) {
          tool('tablolari_listele', 'Veri tablolarını ve sütunlarını listeler.', {}, [], async () => store.listTables().map(t => ({ ad: t.name, sutunlar: t.columns, satir: t.rowCount })));
          tool('tablo_ara', 'Bir tablodaki satırları getirir. "esit" verilirse yalnızca bu alanları eşit olan satırlar döner.', {
            tablo: { type: 'string' }, esit: { type: 'object', description: 'ör. {"eposta": "a@b.com"}', additionalProperties: true }, limit: { type: 'integer' },
          }, ['tablo'], async a => { const q = store.queryRows(a.tablo, r => Object.entries(a.esit || {}).every(([k, v]) => str(r[k]) === str(v)), { limit: Math.min(a.limit || 50, 200) }); return { toplam: q.total, satirlar: q.rows }; });
          tool('tablo_ekle', 'Bir tabloya satır ekler.', { tablo: { type: 'string' }, satirlar: { type: 'array', items: { type: 'object', additionalProperties: true } } }, ['tablo', 'satirlar'],
            async a => ({ eklenen: store.insertRows(a.tablo, (a.satirlar || []).slice(0, 500)).length }));
        }
        for (const w of c.p.workflows || []) {
          if (!w.workflowId) continue;
          const name = `akis_${slug(w.name || store.getWorkflow(w.workflowId)?.name || w.workflowId).replace(/-/g, '_')}`.slice(0, 60);
          tool(name, w.description || `"${w.name}" akışını çalıştırır`, { girdi: { type: 'object', description: 'Akışa gönderilecek veri', additionalProperties: true } }, ['girdi'],
            async a => (await c.runSub(w.workflowId, [{ json: isObj(a.girdi) ? a.girdi : { deger: a.girdi } }])).map(i => i.json));
        }

        const mem = c.p.memory ? c.memory() : null;
        const out = [];
        for (let i = 0; i < c.items.length; i++) {
          const it = c.items[i];
          const prompt = str(c.R(c.p.prompt, it, i)).trim();
          if (!prompt) throw new Error('Kullanıcı mesajı boş');
          const sid = mem ? str(c.R(c.p.session, it, i)) || 'varsayilan' : null;
          const history = mem ? (mem[sid] || []) : [];
          const messages = [...history.map(h => ({ role: h.role, content: h.text })), { role: 'user', content: prompt }];
          const steps = []; let usage = { girdi: 0, cikti: 0 }; let res;
          for (let step = 0; ; step++) {
            c.checkAbort();
            res = await claudeCall(Anthropic, client, {
              model: c.p.model, max_tokens: 16000, messages, output_config: { effort: c.p.effort || 'medium' },
              system: str(c.R(c.p.system || '', it, i)) || undefined, ...(tools.length ? { tools } : {}),
            }, c.signal);
            usage.girdi += res.usage.input_tokens; usage.cikti += res.usage.output_tokens;
            if (res.stop_reason === 'refusal') throw new Error('Claude bu isteği reddetti');
            if (res.stop_reason !== 'tool_use') break;
            if (step >= (Number(c.p.maxSteps) || 10)) { c.log('En fazla araç adımına ulaşıldı'); break; }
            messages.push({ role: 'assistant', content: res.content });
            const results = [];
            for (const b of res.content.filter(x => x.type === 'tool_use')) {
              let content, isError = false;
              try { content = cut(await impl[b.name](b.input || {})); }
              catch (e) { content = `Hata: ${e.message}`; isError = true; }
              steps.push({ arac: b.name, girdi: b.input, sonuc: content.slice(0, 500), hata: isError || undefined });
              c.log(`🔧 ${b.name}(${JSON.stringify(b.input).slice(0, 120)})${isError ? ' → hata' : ''}`);
              results.push({ type: 'tool_result', tool_use_id: b.id, content, ...(isError ? { is_error: true } : {}) });
            }
            messages.push({ role: 'user', content: results });
          }
          const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
          c.log(`${res.model}: ${usage.girdi} girdi, ${usage.cikti} çıktı token, ${steps.length} araç çağrısı`);
          if (mem) { mem[sid] = [...history, { role: 'user', text: prompt }, { role: 'assistant', text: text || '…' }].slice(-(Number(c.p.memorySize) || 20)); if (mem[sid][0]?.role === 'assistant') mem[sid].shift(); c.saveMemory(); }
          const o = clone(it.json); setPath(o, c.p.output || 'yanit', text);
          if (steps.length) o.araclar = steps;
          out.push({ json: o });
        }
        return [out];
      },
    },

    /* ===== triggers ===== */
    chatTrigger: {
      label: 'Sohbet', cat: 'trigger', icon: 'chat', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Program bir sohbet sayfası açar (/sohbet/<yol>). Her mesaj akışı çalıştırır; akışın son node\'unun "yanıt alanı" sohbete cevap olarak yazılır. Claude ajanı ile birlikte kullanın.',
      params: [
        { key: 'path', label: 'Yol', type: 'text', def: 'asistan', help: 'Adres: /sohbet/<yol>' },
        { key: 'title', label: 'Sayfa başlığı', type: 'text', def: 'Asistan' },
        { key: 'welcome', label: 'Karşılama mesajı', type: 'textarea', def: 'Merhaba! Size nasıl yardımcı olabilirim?' },
        { key: 'replyField', label: 'Yanıt alanı', type: 'text', def: 'yanit', help: 'Son node\'un çıktısında cevabın bulunduğu alan.' },
        { key: 'sample', label: 'Editörden test mesajı', type: 'text', def: 'Merhaba, bugün günlerden ne?' },
      ],
      sub: '/sohbet/{path}',
      async run(c) { return [[{ json: c.trigger?.chat ?? { mesaj: c.p.sample || 'Merhaba', oturum: 'editor-testi' } }]]; },
    },
    rssTrigger: {
      label: 'RSS yeni yazı', cat: 'trigger', icon: 'rss', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken RSS/Atom akışını düzenli kontrol eder; yeni yazı çıkınca akışı başlatır. İlk kontrolde mevcut yazılar yalnızca hatırlanır.',
      params: pollParams(15, 'm', [{ key: 'url', label: 'RSS adresi', type: 'text', def: 'https://www.ntv.com.tr/gundem.rss' }]),
      sub: '{url}',
      async poll(c) {
        const r = await httpRequest({ url: c.p.url, timeout: 30000 });
        if (!r.ok) throw new Error(`RSS ${r.status}`);
        const { items } = M.parseFeed(str(r.body), c.p.url);
        const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
        const fresh = items.filter(x => !seen.has(x.guid || x.link));
        mem.seen = [...new Set([...items.map(x => x.guid || x.link), ...seen])].slice(0, 2000); c.saveMemory();
        return first ? [] : fresh.reverse();
      },
      async run(c) {
        if (c.trigger?.items) return [toItems(c.trigger.items)];
        const r = await httpRequest({ url: c.p.url, timeout: 30000, signal: c.signal });
        return [M.parseFeed(str(r.body), c.p.url).items.slice(0, 5).map(json => ({ json }))];
      },
    },
    telegramTrigger: {
      label: 'Telegram mesajı gelince', cat: 'trigger', icon: 'send', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken botunuza gelen yeni mesajları düzenli kontrol eder ve her mesaj için akışı çalıştırır.',
      params: pollParams(5, 's', [{ key: 'credential', label: 'Telegram botu', type: 'credential', credTypes: ['telegramApi'], def: '' },
        { key: 'removeWebhook', label: 'Botta webhook kuruluysa kaldır', type: 'toggle', def: true, help: 'Telegram, webhook kurulu bir botun mesajlarının sorgulanmasına izin vermez. Açıkken 8n8 webhook\'u kendisi kaldırır.' }]),
      sub: 'her {every} {unit}',
      async poll(c) {
        const cred = await c.credential(c.p.credential);
        const mem = c.memory();
        const api = `${process.env.N8N8_TELEGRAM_API || 'https://api.telegram.org'}/bot${cred.data.token}`;
        const get = () => httpRequest({ url: `${api}/getUpdates?timeout=0&allowed_updates=["message"]${mem.offset ? `&offset=${mem.offset}` : ''}`, timeout: 20000 });
        let r = await get();
        if (!r.body?.ok && r.status === 409 && /webhook/i.test(r.body?.description || '')) {
          if (c.p.removeWebhook === false) throw new Error('Telegram: Bu botta webhook kurulu. "Botta webhook kuruluysa kaldır" ayarını açın ya da webhook\'u kendiniz kaldırın.');
          await httpRequest({ url: `${api}/deleteWebhook`, timeout: 20000 });
          r = await get();
        }
        if (!r.body?.ok) throw new Error(r.status === 401 ? 'Telegram: Bot anahtarı geçersiz' : `Telegram: ${r.body?.description || r.status}`);
        const ups = r.body.result || [];
        if (ups.length) { mem.offset = ups[ups.length - 1].update_id + 1; c.saveMemory(); }
        return ups.filter(u => u.message).map(u => ({ mesaj: u.message.text ?? '', sohbetId: u.message.chat.id, kullanici: u.message.from?.username || '', ad: [u.message.from?.first_name, u.message.from?.last_name].filter(Boolean).join(' '), tarih: new Date(u.message.date * 1000).toISOString(), oturum: `tg-${u.message.chat.id}`, guncelleme: u.update_id }));
      },
      async run(c) { return [c.trigger?.items ? toItems(c.trigger.items) : [{ json: { mesaj: 'Merhaba bot!', sohbetId: 123456, kullanici: 'ornek', ad: 'Örnek Kullanıcı', tarih: new Date().toISOString(), oturum: 'tg-123456' } }]]; },
      eachItem: true,
    },
    fileTrigger: {
      label: 'Klasör izleyici', cat: 'trigger', icon: 'folder', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken dosya klasöründeki (veya alt klasöründeki) yeni ve değişen dosyaları algılar.',
      params: pollParams(10, 's', [
        { key: 'folder', label: 'Alt klasör (boş = dosya klasörünün kendisi)', type: 'text', def: 'gelen' },
        { key: 'events', label: 'Hangi değişiklikler', type: 'select', def: 'add', options: [['add', 'Yalnızca yeni dosyalar'], ['both', 'Yeni ve değişen dosyalar']] },
        { key: 'pattern', label: 'Dosya adı içeriyorsa (boş = hepsi)', type: 'text', def: '' },
      ]),
      sub: 'dosyalar/{folder}',
      async poll(c) {
        const dir = c.p.folder ? safeFile(c.p.folder) : store.DIRS.files;
        fs.mkdirSync(dir, { recursive: true });
        const now = {};
        for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); const st = fs.statSync(fp); if (st.isFile() && (!c.p.pattern || f.includes(c.p.pattern))) now[f] = st.mtimeMs; }
        const mem = c.memory(); const first = !mem.files; const prev = mem.files || {};
        mem.files = now; c.saveMemory();
        if (first) return [];
        const out = [];
        for (const [f, m] of Object.entries(now)) {
          if (!(f in prev)) out.push({ olay: 'eklendi', dosya: path.relative(store.DIRS.files, path.join(dir, f)), ad: f, boyut: fs.statSync(path.join(dir, f)).size, zaman: new Date().toISOString() });
          else if (c.p.events === 'both' && prev[f] !== m) out.push({ olay: 'değişti', dosya: path.relative(store.DIRS.files, path.join(dir, f)), ad: f, boyut: fs.statSync(path.join(dir, f)).size, zaman: new Date().toISOString() });
        }
        return out;
      },
      async run(c) { return [c.trigger?.items ? toItems(c.trigger.items) : [{ json: { olay: 'eklendi', dosya: `${c.p.folder ? c.p.folder + '/' : ''}ornek.csv`, ad: 'ornek.csv', boyut: 120, zaman: new Date().toISOString() } }]]; },
    },

    /* ===== data tables ===== */
    table: {
      label: 'Veri tablosu', cat: 'data', icon: 'table', inputs: 1, outputs: ['main'],
      desc: 'Programın yerleşik tablolarına satır ekler, arar, günceller ya da siler. Tabloları "Tablolar" sayfasından görebilir ve düzenleyebilirsiniz.',
      params: [
        { key: 'table', label: 'Tablo', type: 'table', def: '' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'insert', options: [['insert', 'Satır ekle'], ['upsert', 'Ekle ya da güncelle'], ['find', 'Satır ara'], ['all', 'Tüm satırları getir'], ['update', 'Satırları güncelle'], ['delete', 'Satırları sil']] },
        { key: 'where', label: 'Eşleşme (sütun = değer)', type: 'kv', def: [{ key: 'eposta', value: '{{ $json.eposta }}' }], showIf: { op: ['find', 'update', 'delete'] } },
        { key: 'key', label: 'Eşleştirme sütunu', type: 'text', def: 'id', showIf: { op: 'upsert' } },
        { key: 'dataMode', label: 'Yazılacak veri', type: 'select', def: 'item', options: [['item', 'Öğenin tüm alanları'], ['fields', 'Seçtiğim alanlar']], showIf: { op: ['insert', 'update', 'upsert'] } },
        { key: 'fields', label: 'Alanlar', type: 'kv', def: [{ key: 'ad', value: '{{ $json.ad }}' }], showIf: { op: ['insert', 'update', 'upsert'], dataMode: 'fields' } },
        { key: 'limit', label: 'En fazla satır (0 = sınırsız)', type: 'number', def: 0, min: 0, showIf: { op: ['find', 'all'] } },
      ],
      sub: '{op} · {table}',
      async run(c) {
        if (!c.p.table) throw new Error('Bir tablo seçin');
        // writing to a table name that does not exist yet creates it
        const t = store.findTable(c.p.table) || (['insert', 'upsert'].includes(c.p.op) ? (c.log(`"${c.p.table}" tablosu oluşturuldu`), store.getTable(store.createTable(c.p.table).id)) : store.getTable(c.p.table));
        const data = (it, i) => c.p.dataMode === 'fields' ? kvObject(c.p.fields, c.R, it, i) : clone(it.json);
        // an empty condition, or a value that came out empty (e.g. a missing field), matches nothing:
        // a typo must never update or delete the whole table
        const where = (it, i) => {
          const w = kvObject(c.p.where, c.R, it, i); const ent = Object.entries(w).filter(([k]) => k);
          if (!ent.length) throw new Error('Eşleşme koşulu boş. En az bir sütun ve değer girin (bütün satırlar için "Tüm satırları getir"i kullanın).');
          if (ent.some(([, v]) => v == null || v === '')) { c.log(`${i + 1}. öğede eşleşme değeri boş; satır aranmadı`); return () => false; }
          return r => ent.every(([k, v]) => str(r[k]) === str(v));
        };
        const lim = Number(c.p.limit) || undefined;
        switch (c.p.op) {
          case 'insert': return [store.insertRows(t.id, c.items.map(data)).map(json => ({ json }))];
          case 'all': return [store.queryRows(t.id, () => true, { limit: lim }).rows.map(json => ({ json: clone(json) }))];
          case 'find': return [c.items.flatMap((it, i) => store.queryRows(t.id, where(it, i), { limit: lim }).rows.map(json => ({ json: clone(json) })))];
          case 'update': return [c.items.flatMap((it, i) => store.updateRows(t.id, where(it, i), data(it, i)).map(json => ({ json: clone(json) })))];
          case 'delete': { const gone = c.items.flatMap((it, i) => store.deleteRows(t.id, where(it, i))); c.log(`${gone.length} satır silindi`); return [gone.map(json => ({ json }))]; }
          case 'upsert': {
            const out = [];
            c.items.forEach((it, i) => {
              const d = data(it, i); const kv = d[c.p.key];
              if (kv === undefined) throw new Error(`Öğede "${c.p.key}" alanı yok`);
              const up = store.updateRows(t.id, r => str(r[c.p.key]) === str(kv), d);
              out.push(...(up.length ? up : store.insertRows(t.id, [d])).map(json => ({ json: clone(json) })));
            });
            return [out];
          }
        }
        throw new Error('Bilinmeyen işlem');
      },
    },

    /* ===== web & text ===== */
    rss: {
      label: 'RSS oku', cat: 'action', icon: 'rss', inputs: 1, outputs: ['main'],
      desc: 'RSS ya da Atom akışındaki yazıları öğe olarak getirir.',
      params: [{ key: 'url', label: 'RSS adresi', type: 'expr', def: 'https://www.ntv.com.tr/gundem.rss' }, { key: 'limit', label: 'En fazla yazı (0 = hepsi)', type: 'number', def: 20, min: 0 }],
      sub: '{url}',
      async run(c) {
        const it = c.items[0] || { json: {} }; const url = str(c.R(c.p.url, it, 0));
        const r = await httpRequest({ url, signal: c.signal });
        if (!r.ok) throw new Error(`RSS ${r.status}`);
        const { feed, items } = M.parseFeed(str(r.body), url);
        c.log(`${feed.baslik}: ${items.length} yazı`);
        const n = Number(c.p.limit) || items.length;
        return [items.slice(0, n).map(json => ({ json }))];
      },
    },
    html: {
      label: 'HTML\'den veri çıkar', cat: 'data', icon: 'scan', inputs: 1, outputs: ['main'],
      desc: 'Bir HTML metninden CSS seçicileriyle (h1, .fiyat, #icerik a, a[href]) veri çıkarır ya da sayfanın düz metnini alır. Sayfayı önce HTTP isteği ile çekin.',
      params: [
        { key: 'source', label: 'HTML\'in bulunduğu alan', type: 'text', def: 'veri' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'extract', options: [['extract', 'Seçicilerle değer çıkar'], ['text', 'Sayfanın düz metni'], ['links', 'Tüm bağlantılar'], ['markdown', 'Markdown\'a çevir']] },
        { key: 'rules', label: 'Çıkarılacaklar', type: 'extract', def: [{ key: 'baslik', selector: 'h1', attr: '', all: false }], showIf: { op: 'extract' } },
        { key: 'base', label: 'Göreli bağlantılar için ana adres (isteğe bağlı)', type: 'expr', def: '', showIf: { op: ['extract', 'links'] } },
        { key: 'keep', label: 'Öğenin diğer alanlarını koru', type: 'toggle', def: false },
      ],
      sub: '{op}',
      async run(c) {
        const out = [];
        c.items.forEach((it, i) => {
          const html = str(getPath(it.json, c.p.source || 'veri') ?? '');
          const root = M.parseHTML(html); const base = str(c.R(c.p.base || '', it, i)) || undefined;
          const keep = c.p.keep ? Object.fromEntries(Object.entries(it.json).filter(([k]) => k !== (c.p.source || 'veri'))) : {};
          if (c.p.op === 'text') return out.push({ json: { ...keep, metin: M.cleanText(M.textOf(root, { pretty: true })) } });
          if (c.p.op === 'markdown') return out.push({ json: { ...keep, markdown: M.htmlToMarkdown(html) } });
          if (c.p.op === 'links') { M.selectAll(root, 'a[href]').forEach(a => out.push({ json: { ...keep, metin: M.cleanText(M.textOf(a)), link: M.absUrl(a.attrs.href, base) } })); return; }
          const o = { ...keep };
          for (const r of c.p.rules || []) {
            if (!r.key || !r.selector) continue;
            const els = M.selectAll(root, r.selector);
            const val = el => r.attr === 'html' ? M.innerHTML(el) : r.attr ? (['href', 'src'].includes(r.attr) ? M.absUrl(el.attrs[r.attr] ?? '', base) : el.attrs[r.attr] ?? null) : M.cleanText(M.textOf(el));
            o[r.key] = r.all ? els.map(val) : els[0] ? val(els[0]) : null;
          }
          out.push({ json: o });
        });
        return [out];
      },
    },
    xml: {
      label: 'XML', cat: 'data', icon: 'brackets', inputs: 1, outputs: ['main'],
      desc: 'XML metnini JSON\'a ya da JSON\'u XML\'e çevirir. Öznitelikler @ ile başlar.',
      params: [
        { key: 'op', label: 'Yön', type: 'select', def: 'toJson', options: [['toJson', 'XML → JSON'], ['toXml', 'JSON → XML']] },
        { key: 'field', label: 'XML alanı', type: 'text', def: 'veri', showIf: { op: 'toJson' } },
        { key: 'root', label: 'Kök etiket adı', type: 'text', def: 'kayit', showIf: { op: 'toXml' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'xml', showIf: { op: 'toXml' } },
      ],
      sub: '{op}',
      async run(c) {
        return [c.items.map(it => {
          if (c.p.op === 'toXml') return { json: { [c.p.output || 'xml']: M.jsonToXml(it.json, { rootName: c.p.root || 'kayit' }) } };
          const src = getPath(it.json, c.p.field || 'veri');
          if (typeof src !== 'string') throw new Error(`"${c.p.field}" alanında XML metni yok`);
          return { json: M.xmlToJson(src) };
        })];
      },
    },
    markdown: {
      label: 'Markdown', cat: 'data', icon: 'markdown', inputs: 1, outputs: ['main'],
      desc: 'Markdown metnini HTML\'e (e-posta için) ya da HTML\'i Markdown\'a çevirir.',
      params: [
        { key: 'op', label: 'Yön', type: 'select', def: 'toHtml', options: [['toHtml', 'Markdown → HTML'], ['toMd', 'HTML → Markdown']] },
        { key: 'value', label: 'Metin', type: 'expr', def: '{{ $json.yanit }}' },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'html' },
      ],
      sub: '{op}',
      async run(c) {
        return [c.items.map((it, i) => { const o = clone(it.json); const v = str(c.R(c.p.value, it, i)); setPath(o, c.p.output || 'html', c.p.op === 'toMd' ? M.htmlToMarkdown(v) : M.markdownToHtml(v)); return { json: o }; })];
      },
    },
    text: {
      label: 'Metin işlemleri', cat: 'data', icon: 'type', inputs: 1, outputs: ['main'],
      desc: 'Metinde değiştirme, bölme, regex ile çıkarma, büyük/küçük harf, kırpma, kısaltma, URL\'ye uygun hale getirme ve sayma işlemleri.',
      params: [
        { key: 'value', label: 'Metin', type: 'expr', def: '{{ $json.mesaj }}' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'replace', options: [['replace', 'Değiştir'], ['split', 'Böl (diziye)'], ['extract', 'Regex ile çıkar'], ['upper', 'BÜYÜK HARF'], ['lower', 'küçük harf'], ['title', 'Her Kelime Büyük'], ['trim', 'Baştaki/sondaki boşlukları sil'], ['truncate', 'Kısalt'], ['slug', 'URL\'ye uygun (slug)'], ['count', 'Karakter ve kelime say'], ['stripHtml', 'HTML etiketlerini sil']] },
        { key: 'find', label: 'Aranan', type: 'text', def: '', showIf: { op: 'replace' } },
        { key: 'replace', label: 'Yerine', type: 'expr', def: '', showIf: { op: 'replace' } },
        { key: 'regex', label: 'Aranan bir regex', type: 'toggle', def: false, showIf: { op: 'replace' } },
        { key: 'sep', label: 'Ayraç', type: 'text', def: ',', showIf: { op: 'split' } },
        { key: 'pattern', label: 'Regex', type: 'text', def: '\\d+', showIf: { op: 'extract' } },
        { key: 'all', label: 'Tüm eşleşmeler (dizi)', type: 'toggle', def: false, showIf: { op: 'extract' } },
        { key: 'length', label: 'En fazla karakter', type: 'number', def: 100, showIf: { op: 'truncate' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'sonuc' },
      ],
      sub: '{op} → {output}',
      async run(c) {
        return [c.items.map((it, i) => {
          const v = str(c.R(c.p.value, it, i)); let r;
          switch (c.p.op) {
            case 'replace': r = c.p.regex ? v.replace(new RegExp(c.p.find, 'g'), str(c.R(c.p.replace, it, i))) : v.split(c.p.find || '\u0000').join(str(c.R(c.p.replace, it, i))); break;
            case 'split': r = v.split(c.p.sep === '\\n' ? '\n' : c.p.sep ?? ',').map(s => s.trim()).filter(Boolean); break;
            case 'extract': { const re = new RegExp(c.p.pattern, c.p.all ? 'g' : ''); const m = c.p.all ? [...v.matchAll(re)].map(x => x[1] ?? x[0]) : (v.match(re) || [])[1] ?? (v.match(re) || [])[0] ?? null; r = m; break; }
            case 'upper': r = v.toLocaleUpperCase('tr'); break;
            case 'lower': r = v.toLocaleLowerCase('tr'); break;
            case 'title': r = v.toLocaleLowerCase('tr').replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toLocaleUpperCase('tr')); break;
            case 'trim': r = v.trim(); break;
            case 'truncate': { const n = Number(c.p.length) || 100; r = v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v; break; }
            case 'slug': r = slug(v); break;
            case 'count': r = { karakter: v.length, kelime: (v.match(/\S+/g) || []).length, satir: v ? v.split('\n').length : 0 }; break;
            case 'stripHtml': r = M.cleanText(M.textOf(M.parseHTML(v), { pretty: true })); break;
          }
          const o = clone(it.json); setPath(o, c.p.output || 'sonuc', r); return { json: o };
        })];
      },
    },
    rename: {
      label: 'Alanları yeniden adlandır', cat: 'data', icon: 'tag', inputs: 1, outputs: ['main'],
      desc: 'Alan adlarını değiştirir (nokta ile iç içe alan yazılabilir).',
      params: [{ key: 'pairs', label: 'Eski ad → yeni ad', type: 'kv', def: [{ key: 'musteri', value: 'ad_soyad' }] }],
      sub: 'fields',
      async run(c) {
        return [c.items.map(it => {
          const o = clone(it.json);
          for (const r of c.p.pairs || []) { if (!r.key || !r.value) continue; const v = getPath(o, r.key); if (v === undefined) continue; const ks = r.key.split('.'); let p = o; ks.slice(0, -1).forEach(k => { p = p?.[k]; }); if (p) delete p[ks[ks.length - 1]]; setPath(o, r.value, v); }
          return { json: o };
        })];
      },
    },
    compare: {
      label: 'Veri setlerini karşılaştır', cat: 'logic', icon: 'diff', inputs: 2, outputs: ['yalnız A', 'aynı', 'farklı', 'yalnız B'],
      desc: 'İki girdiyi ortak bir alana göre karşılaştırır: yalnızca A\'da olanlar, iki tarafta aynı olanlar, farklı olanlar ve yalnızca B\'de olanlar ayrı çıkışlardan çıkar.',
      params: [
        { key: 'keyA', label: 'A\'daki ortak alan', type: 'text', def: 'id' },
        { key: 'keyB', label: 'B\'deki ortak alan', type: 'text', def: 'id' },
        { key: 'ignore', label: 'Karşılaştırmada yok sayılacak alanlar (virgülle)', type: 'text', def: '' },
      ],
      sub: '{keyA} ↔ {keyB}',
      async run(c) {
        const [a = [], b = []] = c.inputs; const ign = String(c.p.ignore || '').split(',').map(s => s.trim()).filter(Boolean);
        const strip = o => { const x = clone(o); for (const k of ign) delete x[k]; return JSON.stringify(Object.keys(x).sort().map(k => [k, x[k]])); };
        const bm = new Map(b.map(x => [str(getPath(x.json, c.p.keyB)), x]));
        const onlyA = [], same = [], diff = [], used = new Set();
        for (const x of a) {
          const k = str(getPath(x.json, c.p.keyA)); const y = bm.get(k);
          if (!y) { onlyA.push(x); continue; }
          used.add(k);
          if (strip(x.json) === strip(y.json)) same.push(x);
          else { const changed = [...new Set([...Object.keys(x.json), ...Object.keys(y.json)])].filter(f => !ign.includes(f) && JSON.stringify(x.json[f]) !== JSON.stringify(y.json[f])); diff.push({ json: { anahtar: k, farkli: changed, a: x.json, b: y.json } }); }
        }
        return [onlyA, same, diff, b.filter(y => !used.has(str(getPath(y.json, c.p.keyB))))];
      },
    },
  };

  return NODES;
};
