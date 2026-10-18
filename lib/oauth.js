'use strict';
/* OAuth2 sign-in for credentials ("Hesaba bağlan").
   The editor opens /oauth/start?cred=<id> in a popup; the provider sends the user back to
   /oauth/callback, where the code is exchanged for tokens that are stored (encrypted) inside the
   credential. Nodes call accessToken(cred) and get a fresh token, refreshed when it is about to expire. */
const crypto = require('crypto');
const store = require('./store');

const env = (k, d) => process.env[k] || d;
const GOOGLE_SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  drive: 'https://www.googleapis.com/auth/drive',
  calendar: 'https://www.googleapis.com/auth/calendar',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
};
/* Provider presets. Each returns { authUrl, tokenUrl, scope, extra } for a credential's data. */
const PROVIDERS = {
  googleOAuth: d => ({
    authUrl: env('N8N8_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: env('N8N8_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    scope: ['openid', 'email', ...String(d.services || 'gmail,drive,calendar,sheets').split(',').map(s => GOOGLE_SCOPES[s.trim()]).filter(Boolean)].join(' '),
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  }),
  oauth2: d => ({ authUrl: d.authUrl, tokenUrl: d.tokenUrl, scope: d.scope || '', extra: {} }),
};
const isOAuth = type => !!PROVIDERS[type];

const pending = new Map(); // state -> { credId, verifier, redirect, at }
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

function startUrl(credId, redirect) {
  const c = store.getCredentialData(credId);
  if (!c || !isOAuth(c.type)) throw Object.assign(new Error('OAuth kimlik bilgisi bulunamadı'), { status: 404 });
  const p = PROVIDERS[c.type](c.data);
  if (!c.data.clientId || !c.data.clientSecret) throw Object.assign(new Error('Önce istemci kimliğini (Client ID) ve gizli anahtarı (Client secret) kaydedin'), { status: 400 });
  if (!p.authUrl || !p.tokenUrl) throw Object.assign(new Error('Yetkilendirme ve token adreslerini girin'), { status: 400 });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
  const state = crypto.randomBytes(18).toString('base64url'); const { verifier, challenge } = pkce();
  pending.set(state, { credId, verifier, redirect, at: Date.now() });
  const u = new URL(p.authUrl);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: c.data.clientId, redirect_uri: redirect, scope: p.scope, state, code_challenge: challenge, code_challenge_method: 'S256', ...p.extra })) if (v) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(tokenUrl, params, d) {
  const body = new URLSearchParams({ ...params, client_id: d.clientId, client_secret: d.clientSecret });
  let r;
  try { r = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`Token sunucusuna ulaşılamadı: ${e.cause?.message || e.message}`); }
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
  if (!r.ok || !j.access_token) throw new Error(`Giriş başarısız: ${j.error_description || j.error || r.status}`);
  return j;
}
const tokensOf = (j, old = {}) => ({
  access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token || '',
  expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : 0, granted_scope: j.scope || old.granted_scope || '',
});

async function finish(state, code) {
  const st = pending.get(state); pending.delete(state);
  if (!st) throw new Error('Giriş isteği bulunamadı ya da süresi doldu. Pencereyi kapatıp "Hesaba bağlan"a yeniden basın.');
  const c = store.getCredentialData(st.credId); if (!c) throw new Error('Kimlik bilgisi silinmiş');
  const p = PROVIDERS[c.type](c.data);
  const j = await tokenRequest(p.tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: st.redirect, code_verifier: st.verifier }, c.data);
  let account = '';
  if (j.id_token) { try { account = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch {} }
  store.saveCredential({ id: c.id, data: { ...tokensOf(j, c.data), account } });
  return { name: c.name, account };
}

const refreshing = new Map(); // credId -> promise, so parallel nodes refresh once
async function accessToken(cred) {
  const d = cred.data;
  if (!d.access_token) throw new Error(`"${cred.name}" henüz bir hesaba bağlanmamış. Kimlik bilgileri sayfasında "Hesaba bağlan"a basın.`);
  if (!d.expires_at || d.expires_at - Date.now() > 60000) return d.access_token;
  if (!d.refresh_token) throw new Error(`"${cred.name}" oturumunun süresi doldu. "Hesaba bağlan" ile yeniden bağlanın.`);
  if (!refreshing.has(cred.id)) refreshing.set(cred.id, (async () => {
    try {
      const j = await tokenRequest(PROVIDERS[cred.type](d).tokenUrl, { grant_type: 'refresh_token', refresh_token: d.refresh_token }, d);
      const t = tokensOf(j, d); store.saveCredential({ id: cred.id, data: t }); return t.access_token;
    } finally { refreshing.delete(cred.id); }
  })());
  return refreshing.get(cred.id);
}

module.exports = { PROVIDERS, isOAuth, startUrl, finish, accessToken, GOOGLE_SCOPES };
