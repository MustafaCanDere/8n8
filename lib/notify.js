'use strict';
/* Error notifications ("Hata bildirimleri", settings page): when an automatic run fails, send a short message
   by Telegram, e-mail or a Slack/Discord webhook without building an error workflow. A workflow pages at
   most once per `throttle` minutes; failures in between are counted and mentioned in the next message. */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { sendMail } = require('./smtp');

const FILE = path.join(store.DATA, 'bildirim.json');
const DEF = { kanal: '', credential: '', hedef: '', manuel: false, throttle: 15 };
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const CHANNELS = { telegram: 'telegramApi', email: 'smtp', webhook: 'webhookUrl' };

let settings = { ...DEF };
try { settings = { ...DEF, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const get = () => ({ ...settings });
function set(s) {
  const n = { ...DEF, ...settings, ...s };
  n.kanal = String(n.kanal || ''); n.credential = String(n.credential || ''); n.hedef = String(n.hedef || '').trim();
  n.manuel = !!n.manuel; n.throttle = Math.max(0, Math.min(1440, Math.round(Number(n.throttle) || 0)));
  if (n.kanal) {
    if (!CHANNELS[n.kanal]) throw bad('Bilinmeyen bildirim kanalı');
    const c = store.getCredentialData(n.credential);
    if (!c) throw bad('Bildirim için bir kimlik bilgisi seçin');
    if (c.type !== CHANNELS[n.kanal]) throw bad('Seçilen kimlik bilgisi bu kanala uymuyor');
    if (n.kanal !== 'webhook' && !n.hedef) throw bad(n.kanal === 'telegram' ? 'Telegram sohbet kimliğini girin' : 'Bildirimin gideceği e-posta adresini girin');
  }
  settings = n; fs.writeFileSync(FILE, JSON.stringify(n, null, 2)); return get();
}

async function send(text, subject, s = settings) {
  const c = store.getCredentialData(s.credential); if (!c) throw new Error('Bildirim kimlik bilgisi silinmiş');
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Bildirim gönderilemedi (${r.status}): ${(await r.text()).slice(0, 200)}`);
  };
  if (s.kanal === 'telegram') return post(`${process.env.N8N8_TELEGRAM_API || 'https://api.telegram.org'}/bot${c.data.token}/sendMessage`, { chat_id: s.hedef, text });
  if (s.kanal === 'email') return sendMail(c.data, { from: c.data.user, to: s.hedef, subject, text });
  if (s.kanal === 'webhook') return post(c.data.url, /discord/.test(c.data.url) ? { content: text } : { text });
  throw new Error('Bildirim kanalı seçilmemiş');
}

const last = new Map(); // workflowId -> { at, skipped }
function onEnd(wf, exec, publicUrl) {
  const s = settings;
  if (!s.kanal || exec.status !== 'error' || /testi$/.test(exec.mode) || exec.mode === 'hata akışı' || (exec.mode === 'manuel' && !s.manuel)) return;
  const l = last.get(wf.id);
  if (l && Date.now() - l.at < s.throttle * 60000) { l.skipped++; return; }
  const skipped = l?.skipped || 0;
  last.set(wf.id, { at: Date.now(), skipped: 0 });
  const text = [`⚠️ Auto-Move: "${wf.name}" akışı hata verdi`, `Node: ${exec.lastNode || '-'}`, `Hata: ${String(exec.error || '').slice(0, 500)}`, `Nasıl başladı: ${exec.mode}`,
    skipped ? `Son bildirimden beri ${skipped} hata daha oldu.` : '', `Ayrıntı: ${publicUrl}/#/calistirma/${exec.id}`].filter(Boolean).join('\n');
  send(text, `Auto-Move: "${wf.name}" akışı hata verdi`).catch(e => console.error('Hata bildirimi:', e.message));
}

module.exports = { get, set, send, onEnd, CHANNELS };
