'use strict';
/* Integration nodes: SQL databases (PostgreSQL, MySQL / MariaDB, SQLite) and Google Sheets.
   Merged into NODES by nodes.js. Database drivers are loaded only when a node uses them. */
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const oauth = require('./oauth');

const CREDENTIAL_TYPES = {
  postgres: { label: 'PostgreSQL', fields: [{ key: 'host', label: 'Sunucu', def: 'localhost' }, { key: 'port', label: 'Port', def: '5432' }, { key: 'database', label: 'Veritabanı' }, { key: 'user', label: 'Kullanıcı adı' }, { key: 'password', label: 'Şifre', secret: true }, { key: 'ssl', label: 'SSL', def: 'false', options: [['false', 'Kapalı'], ['true', 'Açık'], ['noverify', 'Açık (sertifikayı doğrulama)']] }] },
  mysql: { label: 'MySQL / MariaDB', fields: [{ key: 'host', label: 'Sunucu', def: 'localhost' }, { key: 'port', label: 'Port', def: '3306' }, { key: 'database', label: 'Veritabanı' }, { key: 'user', label: 'Kullanıcı adı' }, { key: 'password', label: 'Şifre', secret: true }, { key: 'ssl', label: 'SSL', def: 'false', options: [['false', 'Kapalı'], ['true', 'Açık']] }] },
  sqlite: { label: 'SQLite dosyası', fields: [{ key: 'file', label: 'Dosya adı', def: 'veri.db', help: 'Dosya klasöründe (~/.8n8/dosyalar) tutulur; yoksa oluşturulur.' }] },
  googleOAuth: { label: 'Google hesabı (Gmail, Drive, Takvim, E-Tablolar)', oauth: true, fields: [
    { key: 'clientId', label: 'İstemci kimliği (Client ID)', help: 'Google Cloud Console → API\'ler ve Hizmetler → Kimlik bilgileri → OAuth istemci kimliği (Web uygulaması). Aşağıdaki yönlendirme adresini oraya ekleyin.' },
    { key: 'clientSecret', label: 'İstemci gizli anahtarı (Client secret)', secret: true },
    { key: 'services', label: 'İzin istenecek servisler', def: 'gmail,drive,calendar,sheets', help: 'Virgülle: gmail, drive, calendar, sheets. Değiştirirseniz yeniden bağlanın.' }] },
  oauth2: { label: 'OAuth2 (başka servisler)', oauth: true, fields: [
    { key: 'clientId', label: 'İstemci kimliği (Client ID)' }, { key: 'clientSecret', label: 'İstemci gizli anahtarı', secret: true },
    { key: 'authUrl', label: 'Yetkilendirme adresi', def: 'https://' }, { key: 'tokenUrl', label: 'Token adresi', def: 'https://' }, { key: 'scope', label: 'İzinler (scope, boşlukla)', def: '' }] },
  googleServiceAccount: { label: 'Google hizmet hesabı', fields: [{ key: 'json', label: 'Hizmet hesabı anahtarı (JSON)', secret: true, multiline: true, help: 'Google Cloud Console → IAM → Hizmet hesapları → Anahtarlar → JSON. Tabloyu bu hesabın e-posta adresiyle paylaşın.' }] },
};

module.exports = function integrationNodes(h) {
  const { toItems, isObj, safeFile, httpRequest } = h;
  const ident = (name, q) => String(name).split('.').map(p => { if (!/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(p)) throw new Error(`Geçersiz tablo ya da sütun adı: ${name}`); return q + p + q; }).join('.');
  const cell = v => v === undefined ? null : isObj(v) || Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  const splitList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

  /* ---------- database connections ---------- */
  function need(mod, pkg) {
    try { return require(mod); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND') throw new Error(`${pkg} sürücüsü kurulu değil. Program klasöründe "npm install" çalıştırın.`); throw e; }
  }
  async function connect(type, d) {
    if (type === 'postgres') {
      const pg = need('pg', 'PostgreSQL'); const { Client } = pg;
      pg.types.setTypeParser(20, v => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; }); // count(*) and bigint ids as numbers
      const client = new Client({ host: d.host, port: Number(d.port) || 5432, database: d.database, user: d.user, password: d.password, connectionTimeoutMillis: 15000, ssl: d.ssl === 'true' ? true : d.ssl === 'noverify' ? { rejectUnauthorized: false } : undefined });
      try { await client.connect(); } catch (e) { throw new Error(`Veritabanına bağlanılamadı: ${e.message}`); }
      return { q: '"', ph: i => `$${i}`, returning: true, query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows || [], affected: r.rowCount ?? 0 }; }, close: () => client.end().catch(() => {}) };
    }
    if (type === 'mysql') {
      const mysql = need('mysql2/promise', 'MySQL');
      let conn;
      try { conn = await mysql.createConnection({ host: d.host, port: Number(d.port) || 3306, database: d.database, user: d.user, password: d.password, connectTimeout: 15000, ssl: d.ssl === 'true' ? {} : undefined, dateStrings: true }); }
      catch (e) { throw new Error(`Veritabanına bağlanılamadı: ${e.message}`); }
      return { q: '`', ph: () => '?', query: async (sql, params) => { const [r] = await conn.query(sql, params); return Array.isArray(r) ? { rows: r, affected: r.length } : { rows: [], affected: r.affectedRows ?? 0, insertId: r.insertId }; }, close: () => conn.end().catch(() => {}) };
    }
    if (type === 'sqlite') {
      let DatabaseSync;
      const emit = process.emitWarning; // node:sqlite prints an "experimental" warning on first load
      try { process.emitWarning = () => {}; ({ DatabaseSync } = require('node:sqlite')); } catch { throw new Error('SQLite için Node.js 22.5 ya da daha yeni bir sürüm gerekir.'); } finally { process.emitWarning = emit; }
      const file = safeFile(d.file || 'veri.db');
      const db = new DatabaseSync(file);
      return { q: '"', ph: () => '?', returning: true, query: async (sql, params) => {
        const st = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...params).map(r => ({ ...r })), affected: 0 };
        const r = st.run(...params); return { rows: [], affected: Number(r.changes), insertId: Number(r.lastInsertRowid) };
      }, close: () => { try { db.close(); } catch {} } };
    }
    throw new Error('Desteklenmeyen veritabanı türü');
  }
  const credKind = { postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite' };

  /* `$1, $2…` in user SQL is rewritten to `?` for MySQL / SQLite, reordering the parameters to match. */
  function bindSQL(db, sql, params) {
    if (db.ph(1) === '$1') return [sql, params];
    const out = [];
    const text = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\$(\d+)/g, (m, n) => { if (!n) return m; out.push(params[Number(n) - 1]); return '?'; });
    return [text, out.length ? out : params];
  }

  /* ---------- Google service-account access token ---------- */
  const tokenCache = new Map();
  async function googleToken(json, scope, signal) {
    let k; try { k = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('Google hizmet hesabı anahtarı geçerli bir JSON değil'); }
    if (!k?.client_email || !k?.private_key) throw new Error('Google anahtarında client_email ya da private_key yok');
    const ck = `${k.client_email}|${scope}`; const hit = tokenCache.get(ck);
    if (hit && hit.exp > Date.now() + 60000) return hit.token;
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000), aud = k.token_uri || 'https://oauth2.googleapis.com/token';
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: k.client_email, scope, aud, iat: now, exp: now + 3600 })}`;
    let sig; try { sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key).toString('base64url'); } catch { throw new Error('Google anahtarındaki private_key okunamadı'); }
    const r = await httpRequest({ method: 'POST', url: aud, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }).toString(), signal });
    if (!r.ok || !r.body?.access_token) throw new Error(`Google oturumu açılamadı: ${r.body?.error_description || r.body?.error || r.status}`);
    tokenCache.set(ck, { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 });
    return r.body.access_token;
  }
  const sheetId = s => { const m = String(s).match(/\/d\/([a-zA-Z0-9-_]+)/); return (m ? m[1] : String(s)).trim(); };
  const colName = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const sheetRef = name => `'${String(name || 'Sayfa1').replace(/'/g, "''")}'`;

  const NODES = {
    database: {
      label: 'Veritabanı (SQL)', cat: 'app', icon: 'db', inputs: 1, outputs: ['main'],
      desc: 'PostgreSQL, MySQL / MariaDB ya da SQLite veritabanında sorgu çalıştırır, satır ekler, okur, günceller ve siler.',
      params: [
        { key: 'credential', label: 'Veritabanı bağlantısı', type: 'credential', credTypes: ['postgres', 'mysql', 'sqlite'], def: '' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'query', options: [['query', 'SQL sorgusu çalıştır'], ['select', 'Satırları oku'], ['insert', 'Satır ekle'], ['update', 'Satırları güncelle'], ['upsert', 'Ekle ya da güncelle'], ['delete', 'Satırları sil']] },
        { key: 'sql', label: 'SQL', type: 'code', def: 'SELECT * FROM musteriler WHERE sehir = $1 LIMIT 50', showIf: { op: 'query' }, help: 'Değerleri SQL\'in içine yazmak yerine $1, $2 … ile yer tutucu kullanın ve aşağıda verin. Bu, SQL enjeksiyonuna karşı korur.' },
        { key: 'params', label: 'Parametreler ($1, $2 … sırasıyla, virgülle)', type: 'expr', def: '{{ $json.sehir }}', showIf: { op: 'query' } },
        { key: 'perItem', label: 'Her öğe için ayrı çalıştır', type: 'toggle', def: false, showIf: { op: 'query' }, help: 'Kapalıyken sorgu bir kez, ilk öğenin değerleriyle çalışır.' },
        { key: 'table', label: 'Tablo', type: 'text', def: 'musteriler', showIf: { op: ['select', 'insert', 'update', 'upsert', 'delete'] } },
        { key: 'columns', label: 'Sütunlar (virgülle, boş = öğedeki bütün alanlar)', type: 'text', def: '', showIf: { op: ['insert', 'update', 'upsert'] } },
        { key: 'key', label: 'Eşleştirme sütunu', type: 'text', def: 'id', showIf: { op: ['update', 'upsert', 'delete'] }, help: 'Satırlar bu sütunun öğedeki değerine göre bulunur. Ekle ya da güncelle için bu sütunda tekil (unique) kısıt olmalı.' },
        { key: 'where', label: 'Koşul sütunu (boş = hepsi)', type: 'text', def: '', showIf: { op: 'select' } },
        { key: 'whereValue', label: 'Koşul değeri', type: 'expr', def: '', showIf: { op: 'select' } },
        { key: 'sort', label: 'Sırala (sütun, isteğe bağlı)', type: 'text', def: '', showIf: { op: 'select' } },
        { key: 'limit', label: 'En fazla satır', type: 'number', def: 100, min: 1, showIf: { op: 'select' } },
      ],
      sub: '{op} {table}',
      async run(c) {
        const credId = c.p.credential; if (!credId) throw new Error('Bir veritabanı bağlantısı seçin');
        const cred = await c.credential(credId);
        const db = await connect(credKind[cred.type], cred.data);
        const { q } = db; const I = n => ident(n, q);
        const items = c.items.length ? c.items : [{ json: {} }];
        const out = [];
        const exec = async (sql, params) => { const [s, p] = bindSQL(db, sql, params.map(cell)); try { return await db.query(s, p); } catch (e) { throw new Error(`Veritabanı: ${e.message}`); } };
        const colsOf = j => (splitList(c.p.columns).length ? splitList(c.p.columns) : Object.keys(j)).filter(k => k in j);
        try {
          if (c.p.op === 'query') {
            const runOne = async (it, i) => {
              const raw = c.R(c.p.params || '', it, i);
              const params = Array.isArray(raw) ? raw : raw === '' || raw == null ? [] : String(c.p.params).includes(',') ? splitList(c.p.params).map(x => c.R(x, it, i)) : [raw];
              const r = await exec(c.p.sql, params);
              if (r.rows.length) out.push(...r.rows.map(json => ({ json })));
              else out.push({ json: { etkilenenSatir: r.affected, ...(r.insertId ? { eklenenId: r.insertId } : {}) } });
            };
            if (c.p.perItem) for (let i = 0; i < items.length; i++) { c.checkAbort(); await runOne(items[i], i); }
            else await runOne(items[0], 0);
          } else if (c.p.op === 'select') {
            const lim = Math.max(1, Number(c.p.limit) || 100);
            const params = [];
            let sql = `SELECT * FROM ${I(c.p.table)}`;
            if (c.p.where) { params.push(c.R(c.p.whereValue, items[0], 0)); sql += ` WHERE ${I(c.p.where)} = ${db.ph(1)}`; }
            if (c.p.sort) sql += ` ORDER BY ${I(c.p.sort)}`;
            sql += ` LIMIT ${lim}`;
            out.push(...(await exec(sql, params)).rows.map(json => ({ json })));
          } else {
            for (let i = 0; i < items.length; i++) {
              c.checkAbort();
              const j = items[i].json;
              if (c.p.op === 'delete') {
                if (!(c.p.key in j)) throw new Error(`Öğede "${c.p.key}" alanı yok`);
                const r = await exec(`DELETE FROM ${I(c.p.table)} WHERE ${I(c.p.key)} = ${db.ph(1)}`, [j[c.p.key]]);
                out.push({ json: { [c.p.key]: j[c.p.key], silinen: r.affected } });
                continue;
              }
              const cols = colsOf(j);
              if (!cols.length) throw new Error('Eklenecek alan yok');
              const vals = cols.map(k => j[k]);
              if (c.p.op === 'insert' || c.p.op === 'upsert') {
                let sql = `INSERT INTO ${I(c.p.table)} (${cols.map(I).join(', ')}) VALUES (${cols.map((_, x) => db.ph(x + 1)).join(', ')})`;
                if (c.p.op === 'upsert') {
                  if (!cols.includes(c.p.key)) throw new Error(`Öğede eşleştirme alanı "${c.p.key}" yok`);
                  const rest = cols.filter(k => k !== c.p.key);
                  sql += q === '`' ? ` ON DUPLICATE KEY UPDATE ${(rest.length ? rest : [c.p.key]).map(k => `${I(k)} = VALUES(${I(k)})`).join(', ')}`
                    : ` ON CONFLICT (${I(c.p.key)}) DO ${rest.length ? `UPDATE SET ${rest.map(k => `${I(k)} = excluded.${I(k)}`).join(', ')}` : 'NOTHING'}`;
                }
                if (db.returning) sql += ' RETURNING *';
                const r = await exec(sql, vals);
                out.push({ json: r.rows[0] || { ...j, ...(r.insertId ? { id: j.id ?? r.insertId } : {}) } });
              } else {
                if (!(c.p.key in j)) throw new Error(`Öğede "${c.p.key}" alanı yok`);
                const set = cols.filter(k => k !== c.p.key);
                if (!set.length) throw new Error('Güncellenecek alan yok');
                let sql = `UPDATE ${I(c.p.table)} SET ${set.map((k, x) => `${I(k)} = ${db.ph(x + 1)}`).join(', ')} WHERE ${I(c.p.key)} = ${db.ph(set.length + 1)}`;
                if (db.returning) sql += ' RETURNING *';
                const r = await exec(sql, [...set.map(k => j[k]), j[c.p.key]]);
                out.push(...(r.rows.length ? r.rows.map(json => ({ json })) : [{ json: { [c.p.key]: j[c.p.key], ...Object.fromEntries(set.map(k => [k, j[k]])), guncellenen: r.affected } }]));
              }
            }
          }
        } finally { await db.close(); }
        return [out];
      },
    },

    sheets: {
      label: 'Google E-Tablolar', cat: 'app', icon: 'table', inputs: 1, outputs: ['main'],
      desc: 'Google E-Tablolar\'dan satır okur, satır ekler, bir sütuna göre günceller ya da sayfayı temizler. İlk satır başlık sayılır.',
      params: [
        { key: 'credential', label: 'Google hesabı ya da hizmet hesabı', type: 'credential', credTypes: ['googleOAuth', 'googleServiceAccount'], def: '' },
        { key: 'sheet', label: 'Tablo adresi ya da kimliği', type: 'expr', def: '', help: 'Tarayıcıdaki adresi olduğu gibi yapıştırabilirsiniz.' },
        { key: 'tab', label: 'Sayfa adı', type: 'text', def: 'Sayfa1' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'read', options: [['read', 'Satırları oku'], ['append', 'Satır ekle'], ['update', 'Ekle ya da güncelle (sütuna göre)'], ['clear', 'Başlık dışındaki satırları temizle']] },
        { key: 'key', label: 'Eşleştirme sütunu', type: 'text', def: 'eposta', showIf: { op: 'update' } },
        { key: 'filterCol', label: 'Sütuna göre süz (boş = hepsi)', type: 'text', def: '', showIf: { op: 'read' } },
        { key: 'filterVal', label: 'Değer', type: 'expr', def: '', showIf: { op: 'read' } },
      ],
      sub: '{op} {tab}',
      async run(c) {
        const cred = await c.credential(c.p.credential);
        const token = cred.type === 'googleOAuth' ? await oauth.accessToken(cred) : await googleToken(cred.data.json, 'https://www.googleapis.com/auth/spreadsheets', c.signal);
        const base = `${process.env.N8N8_GOOGLE_SHEETS_API || 'https://sheets.googleapis.com'}/v4/spreadsheets/${encodeURIComponent(sheetId(c.R(c.p.sheet, c.items[0] || { json: {} }, 0)))}`;
        if (base.endsWith('/')) throw new Error('Tablo adresini girin');
        const call = async (method, p, body) => {
          const r = await httpRequest({ method, url: base + p, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: c.signal });
          if (!r.ok) throw new Error(`Google E-Tablolar (${r.status}): ${r.body?.error?.message || (r.status === 403 ? 'erişim yok; tabloyu hizmet hesabının e-postasıyla paylaşın' : r.status === 404 ? 'tablo ya da sayfa bulunamadı' : 'hata')}`);
          return r.body;
        };
        const tab = sheetRef(c.p.tab);
        const readAll = async () => (await call('GET', `/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE`)).values || [];
        const rows = await readAll();
        let header = (rows[0] || []).map(String);
        const toObj = (r, n) => Object.fromEntries([...header.map((h, i) => [h, r[i] ?? '']), ['_satir', n]]);
        if (c.p.op === 'read') {
          let out = rows.slice(1).map((r, i) => toObj(r, i + 2));
          if (c.p.filterCol) { const v = String(c.R(c.p.filterVal, c.items[0] || { json: {} }, 0)); out = out.filter(o => String(o[c.p.filterCol]) === v); }
          return [out.map(json => ({ json }))];
        }
        if (c.p.op === 'clear') {
          await call('POST', `/values/${encodeURIComponent(`${tab}!A2:ZZZ`)}:clear`, {});
          return [[{ json: { temizlenen: Math.max(0, rows.length - 1) } }]];
        }
        // append / update: add any new fields as header columns first
        const fields = [...new Set(c.items.flatMap(it => Object.keys(it.json).filter(k => k !== '_satir')))];
        const missing = fields.filter(f => !header.includes(f));
        if (missing.length) { header = [...header, ...missing]; await call('PUT', `/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, { values: [header] }); }
        const line = j => header.map(h => { const v = j[h]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v; });
        const out = [];
        if (c.p.op === 'append') {
          const r = await call('POST', `/values/${encodeURIComponent(tab)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: c.items.map(it => line(it.json)) });
          const start = Number(String(r.updates?.updatedRange || '').match(/![A-Z]+(\d+)/)?.[1]) || rows.length + 1;
          c.items.forEach((it, i) => out.push({ json: { ...it.json, _satir: start + i } }));
          return [out];
        }
        const ki = header.indexOf(c.p.key);
        if (ki < 0) throw new Error(`Tabloda "${c.p.key}" başlıklı sütun yok`);
        const index = new Map(rows.slice(1).map((r, i) => [String(r[ki] ?? ''), i + 2]));
        let next = rows.length + 1;
        const data = [];
        for (const it of c.items) {
          const k = String(it.json[c.p.key] ?? '');
          let n = index.get(k), action = 'guncellendi';
          if (!n) { n = next++; index.set(k, n); action = 'eklendi'; }
          data.push({ range: `${tab}!A${n}:${colName(header.length - 1)}${n}`, values: [line(it.json)] });
          out.push({ json: { ...it.json, _satir: n, _islem: action } });
        }
        if (data.length) await call('POST', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data });
        return [out];
      },
    },
  };
  async function test(type, d) {
    if (credKind[type]) { const db = await connect(type, d); try { await db.query('SELECT 1 AS ok', []); } finally { await db.close(); } return 'Bağlantı kuruldu'; }
    if (type === 'googleServiceAccount') { await googleToken(d.json, 'https://www.googleapis.com/auth/spreadsheets'); return `Oturum açıldı (${JSON.parse(d.json).client_email})`; }
    return null;
  }
  return { NODES, CREDENTIAL_TYPES, test };
};
