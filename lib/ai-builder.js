'use strict';
/* "Claude ile oluştur": turns a plain-language description into a workflow using the node catalogue. */
const crypto = require('crypto');
const { NODES, describe, defaults, outputsOf } = require('./nodes');

const id = () => crypto.randomBytes(6).toString('base64url');

function catalogue() {
  const d = describe();
  return d.order.filter(t => t !== 'note').map(t => {
    const n = d.types[t];
    const outs = Array.isArray(n.outputs) ? n.outputs.map((o, i) => `${i}=${o}`).join(', ') : 'kurallara göre (her kural bir çıkış, sonuncusu "diğer")';
    const params = n.params.map(p => {
      const opts = p.options ? ` seçenekler: ${p.options.map(o => o[0]).join('|')}` : '';
      return `    - ${p.key} (${p.type}${opts}) varsayılan: ${JSON.stringify(p.def)}`;
    }).join('\n');
    return `* ${t} — ${n.label}${n.trigger ? ' [TETİKLEYİCİ]' : ''}. ${n.desc} Girdi sayısı: ${n.inputs}. Çıkışlar: ${outs || 'yok'}\n${params}`;
  }).join('\n');
}

const SYSTEM = () => `Sen 8n8 adlı iş akışı otomasyon programı için akış tasarlayan bir uzmansın. Kullanıcının istediği akışı aşağıdaki node türleriyle kur.

İfadeler {{ }} içinde yazılır: {{ $json.alan }} gelen öğenin alanı, {{ $node["Node adı"].json.alan }} başka node'un çıktısı, {{ $vars.AD }} değişken, {{ $now }} şimdiki zaman, {{ $dt.format($now, "DD.MM.YYYY") }}.
Her node öğe listesi alır ve öğe listesi üretir; öğe {json} nesnesidir. Webhook node'unun çıktısında istek gövdesi $json.body altındadır. Form node'u alanları doğrudan $json altına koyar. Sohbet tetikleyicisi {mesaj, oturum} üretir.
Kimlik bilgisi isteyen alanları ("credential") boş bırak; kullanıcı sonra seçecek. Döngü gerekiyorsa "loop" node'unu kullan: çıkış 1 (döngü) gövdeye gider, gövdenin son node'u tekrar loop'un girişine (port 0) bağlanır, çıkış 0 (bitti) sonraki adıma gider.
Node adlarını Türkçe ve kısa ver. Parametrelerde yalnızca varsayılandan farklı olanları yaz.

NODE TÜRLERİ:
${catalogue()}

YANIT BİÇİMİ: Yalnızca tek bir JSON nesnesi döndür, başka hiçbir şey yazma:
{"name": "akış adı", "description": "bir cümle", "nodes": [{"key": "n1", "type": "manual", "name": "Başlat", "params": {}}], "edges": [["n1", 0, "n2", 0]], "notes": "kullanıcının yapması gerekenler (kimlik bilgisi seçmek gibi), kısa"}
edges elemanı: [kaynak key, kaynak çıkış no, hedef key, hedef giriş no].`;

function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = m ? m[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(s);
}

/* lay nodes out left-to-right by depth */
function layout(nodes, edges) {
  const depth = new Map(nodes.map(n => [n.id, 0]));
  for (let k = 0; k < nodes.length; k++) for (const e of edges) { const d = depth.get(e.from) + 1; if (d > depth.get(e.to) && d < 50) depth.set(e.to, d); }
  const cols = new Map();
  for (const n of nodes) { const d = depth.get(n.id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
  for (const [d, list] of cols) list.forEach((n, i) => { n.x = d * 320; n.y = (i - (list.length - 1) / 2) * 170 + 200; });
}

function toWorkflow(spec) {
  if (!spec || !Array.isArray(spec.nodes)) throw new Error('Claude geçerli bir akış döndürmedi');
  const keyMap = new Map(); const nodes = []; const warnings = [];
  for (const n of spec.nodes) {
    if (!NODES[n.type]) { warnings.push(`Bilinmeyen node türü atlandı: ${n.type}`); continue; }
    const params = { ...defaults(n.type) };
    for (const [k, v] of Object.entries(n.params || {})) if (k in params) params[k] = v;
    const node = { id: id(), type: n.type, name: String(n.name || NODES[n.type].label).slice(0, 80), x: 0, y: 0, params, disabled: false, settings: {} };
    keyMap.set(String(n.key), node); nodes.push(node);
  }
  const names = new Set();
  for (const n of nodes) { let nm = n.name, k = 2; while (names.has(nm)) nm = `${n.name} ${k++}`; n.name = nm; names.add(nm); }
  const edges = [];
  for (const e of spec.edges || []) {
    const [a, ap, b, bp] = Array.isArray(e) ? e : [e.from, e.fromPort, e.to, e.toPort];
    const A = keyMap.get(String(a)), B = keyMap.get(String(b));
    if (!A || !B) continue;
    const outs = outputsOf(A).length, ins = NODES[B.type].inputs;
    if (+ap >= outs || +bp >= ins) { warnings.push(`Geçersiz bağlantı atlandı: ${A.name} → ${B.name}`); continue; }
    edges.push({ id: id(), from: A.id, fromPort: +ap || 0, to: B.id, toPort: +bp || 0 });
  }
  if (!nodes.some(n => NODES[n.type].trigger)) throw new Error('Oluşturulan akışta tetikleyici yok; isteği biraz daha açık yazmayı deneyin');
  layout(nodes, edges);
  if (spec.notes) nodes.unshift({ id: id(), type: 'note', name: 'Not', x: Math.min(...nodes.map(n => n.x)), y: Math.min(...nodes.map(n => n.y)) - 150, params: { text: String(spec.notes), color: 'blue' }, disabled: false, settings: {} });
  return { workflow: { name: String(spec.name || 'Yeni akış').slice(0, 120), description: spec.description || '', nodes, edges }, warnings };
}

async function build({ prompt, apiKey, model = 'claude-opus-5-5', current }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); Anthropic = Anthropic.default || Anthropic; }
  catch { throw new Error('Anthropic SDK kurulu değil. Program klasöründe "npm install" çalıştırın.'); }
  const client = new Anthropic({ apiKey });
  const fallbackOK = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'].includes(model);
  const user = current
    ? `Şu anki akış (JSON):\n${JSON.stringify({ name: current.name, nodes: current.nodes.filter(n => n.type !== 'note').map(n => ({ key: n.id, type: n.type, name: n.name, params: n.params })), edges: current.edges.map(e => [e.from, e.fromPort, e.to, e.toPort]) })}\n\nBu akışı şu isteğe göre değiştir ve akışın TAMAMINI döndür:\n${prompt}`
    : `Şu akışı kur:\n${prompt}`;
  const messages = [{ role: 'user', content: user }];
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await client.beta.messages.create({ model, max_tokens: 16000, system: SYSTEM(), messages, output_config: { effort: 'medium' }, ...(fallbackOK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}) });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API anahtarı geçersiz');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic hız sınırına takıldı; biraz sonra tekrar deneyin');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API hatası (${e.status ?? 'ağ'}): ${e.message}`);
      throw e;
    }
    if (res.stop_reason === 'refusal') throw new Error('Claude bu isteği reddetti');
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try { return { ...toWorkflow(extractJSON(text)), model: res.model }; }
    catch (e) {
      if (attempt) throw new Error(`Claude'un yanıtı akışa çevrilemedi: ${e.message}`);
      messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `Yanıtın işlenemedi (${e.message}). Yalnızca istenen biçimde geçerli bir JSON nesnesi döndür.` });
    }
  }
}

module.exports = { build, toWorkflow, catalogue };
