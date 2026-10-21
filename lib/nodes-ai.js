'use strict';
/* Claude-powered helper nodes (Sınıflandır, Bilgi çıkar) and the MCP server trigger, which lets Claude and other
   MCP clients call active workflows as tools. Both AI nodes use structured outputs, so the answer always matches
   the schema built from the node's settings. Merged into NODES by nodes.js. */

/* "ad", "tutar:sayı", "urunler:liste", "acil:evet-hayır", "teslim:tarih" → [{ name, type, desc }] */
const TYPE_ALIASES = { metin: 'string', yazi: 'string', yazı: 'string', string: 'string', text: 'string', sayi: 'number', sayı: 'number', number: 'number', tamsayi: 'integer', tamsayı: 'integer', integer: 'integer', 'evet-hayır': 'boolean', 'evet-hayir': 'boolean', 'evet/hayır': 'boolean', boolean: 'boolean', bool: 'boolean', liste: 'array', array: 'array', tarih: 'date', date: 'date' };
const TYPE_LABEL = { string: 'metin', number: 'sayı', integer: 'tam sayı', boolean: 'evet/hayır', array: 'metin listesi', date: 'tarih' };
function parseFields(rows) {
  const seen = new Set();
  return (rows || []).filter(r => r && String(r.key || '').trim()).map(r => {
    const [rawName, rawType = ''] = String(r.key).split(':').map(s => s.trim());
    const type = rawType ? TYPE_ALIASES[rawType.toLocaleLowerCase('tr')] : 'string';
    if (!type) throw new Error(`"${r.key}" için bilinmeyen tür "${rawType}". Kullanılabilenler: metin, sayı, tamsayı, evet-hayır, liste, tarih`);
    if (!/^[\p{L}_][\p{L}\p{N}_]{0,63}$/u.test(rawName)) throw new Error(`Geçersiz alan adı: "${rawName}" (harf, rakam ve _ kullanın)`);
    if (seen.has(rawName)) throw new Error(`"${rawName}" alanı iki kez yazılmış`);
    seen.add(rawName);
    return { name: rawName, type, desc: String(r.value || '').trim() };
  });
}
function propSchema(f, nullable) {
  const base = f.type === 'array' ? { type: 'array', items: { type: 'string' } } : f.type === 'date' ? { type: 'string', format: 'date' } : { type: f.type };
  const t = nullable ? { ...base, type: [base.type, 'null'] } : base;
  return f.desc ? { ...t, description: f.desc } : t;
}
function objectSchema(fields, { nullable = false, required = true } = {}) {
  return { type: 'object', properties: Object.fromEntries(fields.map(f => [f.name, propSchema(f, nullable)])), required: required ? fields.map(f => f.name) : [], additionalProperties: false };
}
const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));

module.exports = function aiNodes(h) {
  const { MODELS, clone, setPath, safeFile } = h;
  const kb = require('./kb');

  /* one structured-output request; returns the parsed JSON object */
  async function askJSON(c, { system, prompt, schema }) {
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); Anthropic = Anthropic.default || Anthropic; }
    catch { throw new Error('Anthropic SDK kurulu değil. Program klasöründe "npm install" çalıştırın.'); }
    const cred = await c.credential(c.p.credential);
    const client = c._client ||= new Anthropic({ apiKey: cred.data.apiKey });
    const fallbackOK = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'].includes(c.p.model);
    let res;
    try {
      res = await client.beta.messages.create({
        model: c.p.model, max_tokens: 16000, system, messages: [{ role: 'user', content: prompt }],
        output_config: { effort: c.p.effort || 'low', format: { type: 'json_schema', schema } },
        ...(fallbackOK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      }, { signal: c.signal });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API anahtarı geçersiz');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic hız sınırına takıldı; biraz sonra tekrar deneyin ya da node seçeneklerinden yeniden denemeyi açın');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API hatası (${e.status ?? 'ağ'}): ${e.message}`);
      throw e;
    }
    if (res.stop_reason === 'refusal') throw new Error(`Claude bu isteği reddetti${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`);
    if (res.stop_reason === 'max_tokens') throw new Error('Claude yanıtı yarıda kesildi (çıktı sınırı)');
    c.log(`${res.model}: ${res.usage.input_tokens} girdi, ${res.usage.output_tokens} çıktı token`);
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try { return JSON.parse(text); } catch { throw new Error(`Claude geçerli JSON döndürmedi: ${text.slice(0, 200)}`); }
  }
  const common = [
    { key: 'credential', label: 'Anthropic API anahtarı', type: 'credential', credTypes: ['anthropicApi'], def: '' },
    { key: 'model', label: 'Model', type: 'select', def: 'claude-haiku-5-5', options: MODELS },
    { key: 'effort', label: 'Düşünme çabası', type: 'select', def: 'low', options: [['low', 'Düşük (hızlı, ucuz)'], ['medium', 'Orta'], ['high', 'Yüksek']] },
  ];

  const NODES = {
    classify: {
      label: 'Claude ile sınıflandır', cat: 'ai', icon: 'route', inputs: 1, outputs: { from: 'categories', label: 'key', fallback: 'other', fallbackLabel: 'Diğer' },
      desc: 'Her öğenin metnini Claude\'a verdiğiniz kategorilerden birine (ya da birkaçına) ayırır ve öğeyi o kategorinin çıkışına gönderir. Destek taleplerini, e-postaları, yorumları yönlendirmek için.',
      params: [
        ...common,
        { key: 'text', label: 'Sınıflandırılacak metin', type: 'textarea', def: '{{ $json.mesaj }}' },
        { key: 'categories', label: 'Kategoriler (ad = ne zaman seçilir)', type: 'kv', def: [{ key: 'Şikâyet', value: 'Müşteri bir sorundan memnun değil' }, { key: 'Soru', value: 'Bilgi ya da yardım istiyor' }, { key: 'Teşekkür', value: 'Memnuniyetini belirtiyor' }], help: 'Her kategori node\'da ayrı bir çıkış olur.' },
        { key: 'multi', label: 'Birden fazla kategori seçilebilsin', type: 'toggle', def: false, help: 'Açıkken öğe uyduğu her kategorinin çıkışına gider.' },
        { key: 'other', label: '"Diğer" çıkışı (hiçbirine uymayanlar)', type: 'toggle', def: true },
        { key: 'instructions', label: 'Ek talimat (isteğe bağlı)', type: 'textarea', def: '' },
      ],
      sub: '{model}',
      async run(c) {
        const cats = (c.p.categories || []).filter(x => String(x.key || '').trim()).map(x => ({ name: String(x.key).trim(), desc: String(x.value || '').trim() }));
        if (!cats.length) throw new Error('En az bir kategori yazın');
        const names = cats.map(x => x.name); const OTHER = 'Diğer';
        const choices = c.p.other && !names.includes(OTHER) ? [...names, OTHER] : names;
        const schema = c.p.multi
          ? { type: 'object', properties: { kategoriler: { type: 'array', items: { type: 'string', enum: choices } }, gerekce: { type: 'string' } }, required: ['kategoriler', 'gerekce'], additionalProperties: false }
          : { type: 'object', properties: { kategori: { type: 'string', enum: choices }, gerekce: { type: 'string' } }, required: ['kategori', 'gerekce'], additionalProperties: false };
        const system = ['Sen bir metin sınıflandırıcısın. Metni aşağıdaki kategorilere göre sınıflandır.',
          ...cats.map(x => `- ${x.name}${x.desc ? `: ${x.desc}` : ''}`),
          c.p.other ? `- ${OTHER}: yukarıdakilerin hiçbirine uymuyorsa` : 'Metin tam uymasa bile en yakın kategoriyi seç.',
          c.p.multi ? 'Uyan bütün kategorileri seç; hiçbiri uymuyorsa boş liste ver.' : 'Yalnızca bir kategori seç.',
          '"gerekce" alanına tek kısa Türkçe cümle yaz.', str(c.p.instructions).trim()].filter(Boolean).join('\n');
        const outs = [...names.map(() => []), ...(c.p.other ? [[]] : [])];
        for (let i = 0; i < c.items.length; i++) {
          c.checkAbort(); const it = c.items[i];
          const text = str(c.R(c.p.text, it, i)).trim();
          let picked, why = '';
          if (!text) picked = [];
          else { const r = await askJSON(c, { system, prompt: `<metin>\n${text}\n</metin>`, schema }); picked = (c.p.multi ? r.kategoriler : [r.kategori]).filter(x => names.includes(x)); why = r.gerekce || ''; }
          const json = { ...clone(it.json), kategori: c.p.multi ? picked : picked[0] ?? OTHER, gerekce: why };
          if (!picked.length) { if (c.p.other) outs[names.length].push({ json }); continue; }
          for (const p of new Set(picked)) outs[names.indexOf(p)].push({ json: clone(json) });
        }
        return outs;
      },
    },

    extract: {
      label: 'Claude ile bilgi çıkar', cat: 'ai', icon: 'scan', inputs: 1, outputs: ['main'],
      desc: 'Serbest metinden (e-posta, form, belge, sohbet) istediğiniz alanları Claude\'a çıkartır ve öğeye düzgün alanlar olarak ekler. Metinde olmayan bilgi boş (null) gelir.',
      params: [
        ...common,
        { key: 'text', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}' },
        { key: 'fields', label: 'Alanlar (ad:tür = açıklama)', type: 'kv', def: [{ key: 'ad', value: 'Müşterinin adı soyadı' }, { key: 'siparisNo', value: 'Sipariş numarası' }, { key: 'tutar:sayı', value: 'Toplam tutar, TL' }, { key: 'acil:evet-hayır', value: 'Müşteri acele ediyor mu' }], help: 'Türler: metin (varsayılan), sayı, tamsayı, evet-hayır, liste, tarih. Örnek: urunler:liste' },
        { key: 'output', label: 'Sonuç alanı (boş = öğeye doğrudan ekle)', type: 'text', def: '' },
        { key: 'instructions', label: 'Ek talimat (isteğe bağlı)', type: 'textarea', def: '' },
      ],
      sub: '{model}',
      async run(c) {
        const fields = parseFields(c.p.fields); if (!fields.length) throw new Error('En az bir alan yazın');
        const schema = objectSchema(fields, { nullable: true });
        const system = ['Verilen metinden istenen bilgileri çıkar. Metinde açıkça olmayan bir bilgi için null ver; tahmin etme ya da uydurma.',
          'Alanlar:', ...fields.map(f => `- ${f.name} (${TYPE_LABEL[f.type]})${f.desc ? `: ${f.desc}` : ''}`),
          'Tarihleri YYYY-AA-GG biçiminde ver. Sayılarda yalnız sayıyı ver (para birimi ve binlik ayırıcı olmadan).', str(c.p.instructions).trim()].filter(Boolean).join('\n');
        const out = [];
        for (let i = 0; i < c.items.length; i++) {
          c.checkAbort(); const it = c.items[i];
          const text = str(c.R(c.p.text, it, i)).trim();
          const r = text ? await askJSON(c, { system, prompt: `<metin>\n${text}\n</metin>`, schema }) : Object.fromEntries(fields.map(f => [f.name, null]));
          const o = clone(it.json);
          if (c.p.output) setPath(o, c.p.output, r); else Object.assign(o, r);
          out.push({ json: o });
        }
        return [out];
      },
    },

    knowledge: {
      label: 'Bilgi tabanı', cat: 'ai', icon: 'stack', inputs: 1, outputs: ['main'],
      desc: 'Bilgi tabanınızdaki belgelere (SSS, ürün bilgileri, iç dokümanlar) göre Claude\'a soru cevaplatır, ilgili bölümleri bulur ya da bilgi tabanına belge ekler. Belgeleri "Bilgi tabanı" sayfasından yükleyebilirsiniz.',
      params: [
        { key: 'kb', label: 'Bilgi tabanı', type: 'kb', def: '' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'ask', options: [['ask', 'Soru sor (Claude belgelere göre cevaplar)'], ['search', 'İlgili bölümleri bul'], ['add', 'Belge ekle ya da güncelle']] },
        { ...common[0], showIf: { op: 'ask' } }, { ...common[1], def: 'claude-sonnet-5-5', showIf: { op: 'ask' } }, { ...common[2], showIf: { op: 'ask' } },
        { key: 'question', label: 'Soru', type: 'textarea', def: '{{ $json.mesaj }}', showIf: { op: ['ask', 'search'] } },
        { key: 'k', label: 'Kullanılacak bölüm sayısı', type: 'number', def: 6, min: 1, showIf: { op: ['ask', 'search'] } },
        { key: 'instructions', label: 'Ek talimat (isteğe bağlı)', type: 'textarea', def: 'Kısa, nazik ve Türkçe cevap ver.', showIf: { op: 'ask' } },
        { key: 'docName', label: 'Belge adı', type: 'expr', def: '{{ $json.baslik }}.txt', showIf: { op: 'add' }, help: 'Aynı adlı belge varsa yerine konur.' },
        { key: 'source', label: 'İçerik', type: 'select', def: 'text', options: [['text', 'Yazdığım metin'], ['file', 'Dosya klasöründeki bir dosya']], showIf: { op: 'add' } },
        { key: 'content', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'add', source: 'text' } },
        { key: 'file', label: 'Dosya adı (~/.8n8/dosyalar içinde)', type: 'expr', def: 'sss.docx', showIf: { op: 'add', source: 'file' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'cevap', showIf: { op: ['ask', 'search'] } },
      ],
      sub: '{op}',
      async run(c) {
        const items = c.items.length ? c.items : [{ json: {} }];
        const out = [];
        for (let i = 0; i < items.length; i++) {
          c.checkAbort(); const it = items[i]; const o = clone(it.json);
          if (c.p.op === 'add') {
            const name = str(c.R(c.p.docName, it, i)).trim() || 'belge.txt';
            let r;
            if (c.p.source === 'file') {
              const f = safeFile(str(c.R(c.p.file, it, i)));
              if (!require('fs').existsSync(f)) throw new Error(`Dosya bulunamadı: ${require('path').basename(f)}`);
              r = kb.addDoc(c.p.kb, c.p.docName === '{{ $json.baslik }}.txt' ? require('path').basename(f) : name, require('fs').readFileSync(f));
            } else r = kb.addDoc(c.p.kb, name, str(c.R(c.p.content, it, i)));
            out.push({ json: { ...o, belge: r.ad, parca: r.parca, islem: r.guncellendi ? 'guncellendi' : 'eklendi' } });
            continue;
          }
          const q = str(c.R(c.p.question, it, i)).trim(); if (!q) throw new Error(`${i + 1}. öğede soru boş`);
          const found = kb.search(c.p.kb, q, Number(c.p.k) || 6);
          if (c.p.op === 'search') { setPath(o, c.p.output || 'cevap', found); out.push({ json: o }); continue; }
          let ans;
          if (!found.length) ans = { cevap: 'Bu konuda bilgi tabanında bir bilgi bulamadım.', kaynaklar: [], bilgiVar: false };
          else {
            const system = ['Kullanıcının sorusunu YALNIZCA aşağıdaki bölümlere dayanarak cevapla. Bölümlerde cevap yoksa bunu açıkça söyle ve "bilgiVar" alanını false yap; tahmin etme.',
              '"kaynaklar" alanına cevabı dayandırdığın bölümlerin numaralarını yaz.', str(c.p.instructions).trim()].filter(Boolean).join('\n');
            const ctx = found.map((f, k) => `<bolum no="${k + 1}" belge="${f.belge.replace(/"/g, '')}">\n${f.metin}\n</bolum>`).join('\n');
            const schema = { type: 'object', properties: { cevap: { type: 'string' }, kaynaklar: { type: 'array', items: { type: 'integer' } }, bilgiVar: { type: 'boolean' } }, required: ['cevap', 'kaynaklar', 'bilgiVar'], additionalProperties: false };
            ans = await askJSON(c, { system, prompt: `${ctx}\n\n<soru>\n${q}\n</soru>`, schema });
          }
          const srcs = [...new Set((ans.kaynaklar || []).map(n => found[n - 1]?.belge).filter(Boolean))];
          setPath(o, c.p.output || 'cevap', ans.cevap);
          Object.assign(o, { kaynaklar: srcs, bilgiBulundu: !!ans.bilgiVar });
          out.push({ json: o });
        }
        return [out];
      },
    },

    mcpTrigger: {
      label: 'MCP aracı (Claude çağırınca)', cat: 'trigger', icon: 'robot', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akışı bir MCP aracı olarak sunar: Claude Desktop, Claude Code ya da başka bir MCP istemcisi aracı çağırınca akış çalışır ve son node\'un çıktısı araç sonucu olarak döner. Aynı adresteki bütün etkin araçlar tek sunucuda listelenir.',
      params: [
        { key: 'path', label: 'Sunucu adresi', type: 'text', def: 'araclar', help: 'Araçlar /mcp/<adres> adresinde yayınlanır.' },
        { key: 'tool', label: 'Araç adı', type: 'text', def: 'musteri_bul', help: 'İngilizce harf, rakam, _ ve -. Claude aracı bu adla görür.' },
        { key: 'description', label: 'Araç açıklaması', type: 'textarea', def: 'E-posta adresine göre müşteri kaydını getirir.', help: 'Claude aracı ne zaman kullanacağına buna bakarak karar verir; açık yazın.' },
        { key: 'inputs', label: 'Girdiler (ad:tür = açıklama)', type: 'kv', def: [{ key: 'eposta', value: 'Müşterinin e-posta adresi' }], help: 'Türler: metin, sayı, tamsayı, evet-hayır, liste, tarih. Girdiler akışa öğenin alanları olarak gelir.' },
        { key: 'optional', label: 'İsteğe bağlı girdiler (virgülle)', type: 'text', def: '' },
        { key: 'result', label: 'Araç sonucu', type: 'select', def: 'all', options: [['all', 'Son node\'un bütün öğeleri (JSON)'], ['first', 'Yalnız ilk öğe (JSON)'], ['field', 'İlk öğenin bir alanı (metin)']] },
        { key: 'field', label: 'Alan', type: 'text', def: 'yanit', showIf: { result: 'field' } },
        { key: 'auth', label: 'Kimlik doğrulama', type: 'select', def: 'none', options: [['none', 'Yok (yalnız bu bilgisayardan erişiliyorsa)'], ['cred', 'Kayıtlı kimlik bilgisi iste']] },
        { key: 'credential', label: 'Beklenen kimlik bilgisi', type: 'credential', credTypes: ['httpBearer', 'httpHeader', 'httpBasic'], def: '', showIf: { auth: 'cred' }, help: 'Aynı adresteki araçlardan birinde kimlik doğrulama açıksa sunucu ona göre korunur.' },
      ],
      sub: '{tool}',
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        let fields = []; try { fields = parseFields(c.p.inputs); } catch {}
        const ex = { string: 'örnek', number: 1, integer: 1, boolean: true, array: ['örnek'], date: new Date().toISOString().slice(0, 10) };
        return [[{ json: Object.fromEntries(fields.map(f => [f.name, ex[f.type]])) }]];
      },
    },
  };

  /* tool description for tools/list */
  function toolOf(params) {
    const fields = parseFields(params.inputs);
    const optional = new Set(String(params.optional || '').split(',').map(s => s.trim()).filter(Boolean));
    const schema = objectSchema(fields, { required: false });
    schema.required = fields.map(f => f.name).filter(n => !optional.has(n));
    delete schema.additionalProperties;
    return { name: String(params.tool || '').trim(), description: String(params.description || '').trim(), inputSchema: schema };
  }
  return { NODES, toolOf, parseFields };
};
