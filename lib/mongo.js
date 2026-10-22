'use strict';
/* Minimal MongoDB client: BSON, OP_MSG over TCP or TLS, SCRAM-SHA-256 (falls back to SCRAM-SHA-1), mongodb:// and
   mongodb+srv:// connection strings, finds the primary of a replica set. Enough for find/insert/update/delete/aggregate. */
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');

class ObjectId {
  constructor(hex) {
    if (hex == null) { const b = Buffer.alloc(12); b.writeUInt32BE(Math.floor(Date.now() / 1000), 0); crypto.randomBytes(8).copy(b, 4); this.bytes = b; }
    else if (Buffer.isBuffer(hex)) this.bytes = Buffer.from(hex);
    else { if (!/^[0-9a-f]{24}$/i.test(hex)) throw new Error(`Geçersiz ObjectId: ${hex}`); this.bytes = Buffer.from(hex, 'hex'); }
  }
  toString() { return this.bytes.toString('hex'); }
  toJSON() { return this.toString(); }
}

/* ---------- BSON ---------- */
function encode(doc) {
  const parts = [];
  for (const [k, v] of Object.entries(doc)) { if (v === undefined) continue; parts.push(element(k, v)); }
  const body = Buffer.concat(parts); const out = Buffer.alloc(body.length + 5);
  out.writeInt32LE(out.length, 0); body.copy(out, 4); out[out.length - 1] = 0; return out;
}
function element(k, v) {
  const name = Buffer.concat([Buffer.from(k, 'utf8'), Buffer.from([0])]);
  const head = t => Buffer.concat([Buffer.from([t]), name]);
  if (v === null) return head(0x0a);
  if (typeof v === 'boolean') return Buffer.concat([head(0x08), Buffer.from([v ? 1 : 0])]);
  if (typeof v === 'bigint') { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return Buffer.concat([head(0x12), b]); }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { const b = Buffer.alloc(4); b.writeInt32LE(v); return Buffer.concat([head(0x10), b]); }
    if (Number.isSafeInteger(v)) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return Buffer.concat([head(0x12), b]); }
    const b = Buffer.alloc(8); b.writeDoubleLE(v); return Buffer.concat([head(0x01), b]);
  }
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); const b = Buffer.alloc(4); b.writeInt32LE(s.length + 1); return Buffer.concat([head(0x02), b, s, Buffer.from([0])]); }
  if (v instanceof ObjectId) return Buffer.concat([head(0x07), v.bytes]);
  if (v instanceof Date) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v.getTime())); return Buffer.concat([head(0x09), b]); }
  if (v instanceof RegExp) return Buffer.concat([head(0x0b), Buffer.from(v.source), Buffer.from([0]), Buffer.from(v.flags.split('').filter(f => 'imsux'.includes(f)).sort().join('')), Buffer.from([0])]);
  if (Buffer.isBuffer(v)) { const b = Buffer.alloc(5); b.writeInt32LE(v.length); b[4] = 0; return Buffer.concat([head(0x05), b, v]); }
  if (Array.isArray(v)) return Buffer.concat([head(0x04), encode(Object.fromEntries(v.map((x, i) => [String(i), x === undefined ? null : x])))]);
  if (typeof v === 'object') return Buffer.concat([head(0x03), encode(v)]);
  return element(k, String(v));
}
function decode(buf, at = 0, array = false) {
  const end = at + buf.readInt32LE(at); let i = at + 4; const out = array ? [] : {};
  while (i < end - 1) {
    const t = buf[i++]; const z = buf.indexOf(0, i); const key = buf.toString('utf8', i, z); i = z + 1; let v;
    switch (t) {
      case 0x01: v = buf.readDoubleLE(i); i += 8; break;
      case 0x02: case 0x0d: case 0x0e: { const n = buf.readInt32LE(i); v = buf.toString('utf8', i + 4, i + 3 + n); i += 4 + n; break; }
      case 0x03: case 0x04: v = decode(buf, i, t === 0x04); i += buf.readInt32LE(i); break;
      case 0x05: { const n = buf.readInt32LE(i); const sub = buf[i + 4]; const data = Buffer.from(buf.subarray(i + 5, i + 5 + n)); v = sub === 4 && n === 16 ? data.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') : data; i += 5 + n; break; }
      case 0x06: case 0x0a: case 0x7f: case 0xff: v = null; break;
      case 0x07: v = new ObjectId(buf.subarray(i, i + 12)); i += 12; break;
      case 0x08: v = buf[i++] === 1; break;
      case 0x09: v = new Date(Number(buf.readBigInt64LE(i))); i += 8; break;
      case 0x0b: { const a = buf.indexOf(0, i); const b = buf.indexOf(0, a + 1); v = { $regex: buf.toString('utf8', i, a), $options: buf.toString('utf8', a + 1, b) }; i = b + 1; break; }
      case 0x0f: { const n = buf.readInt32LE(i); const sl = buf.readInt32LE(i + 4); v = buf.toString('utf8', i + 8, i + 7 + sl); i += n; break; }
      case 0x10: v = buf.readInt32LE(i); i += 4; break;
      case 0x11: v = { t: buf.readUInt32LE(i + 4), i: buf.readUInt32LE(i) }; i += 8; break;
      case 0x12: { const b = buf.readBigInt64LE(i); v = b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString(); i += 8; break; }
      case 0x13: v = decimal128(buf.subarray(i, i + 16)); i += 16; break;
      default: throw new Error(`BSON türü desteklenmiyor: 0x${t.toString(16)}`);
    }
    if (array) out.push(v); else out[key] = v;
  }
  return out;
}
/* Decimal128 -> string (finite values only; NaN/Infinity come back as words) */
function decimal128(b) {
  const hi = b.readBigUInt64LE(8), lo = b.readBigUInt64LE(0); const neg = hi >> 63n === 1n;
  if (((hi >> 58n) & 0x1fn) === 0x1fn) return (hi >> 57n) & 1n ? 'NaN' : neg ? '-Infinity' : 'Infinity';
  let exp, coef;
  if (((hi >> 61n) & 3n) === 3n) { exp = Number((hi >> 47n) & 0x3fffn) - 6176; coef = 0n; }
  else { exp = Number((hi >> 49n) & 0x3fffn) - 6176; coef = ((hi & 0x1ffffffffffffn) << 64n) | lo; }
  let s = coef.toString();
  if (exp < 0) { s = s.padStart(-exp + 1, '0'); s = `${s.slice(0, s.length + exp)}.${s.slice(s.length + exp)}`; } else s += '0'.repeat(exp);
  return (neg ? '-' : '') + s;
}

/* JSON from the editor -> BSON values: {"$oid": ".."}, {"$date": ".."}, {"$regex": "..", "$options": ".."} and a 24-hex _id */
function fromJSON(v, key) {
  if (Array.isArray(v)) return v.map(x => fromJSON(x));
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof ObjectId) && !Buffer.isBuffer(v)) {
    const ks = Object.keys(v);
    if (ks.length === 1 && ks[0] === '$oid') return new ObjectId(String(v.$oid));
    if (ks.length === 1 && ks[0] === '$date') return new Date(typeof v.$date === 'object' && v.$date.$numberLong ? Number(v.$date.$numberLong) : v.$date);
    if (ks.length === 1 && ks[0] === '$numberLong') return BigInt(v.$numberLong);
    return Object.fromEntries(ks.map(k => [k, fromJSON(v[k], k)]));
  }
  if (key === '_id' && typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)) return new ObjectId(v);
  return v;
}
/* BSON values -> plain JSON for workflow items */
function toJSON(v) {
  if (v instanceof ObjectId) return v.toString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (Array.isArray(v)) return v.map(toJSON);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJSON(x)]));
  return v;
}

/* ---------- connection string ---------- */
async function parseUri(uri) {
  const m = String(uri || '').trim().match(/^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/);
  if (!m) throw new Error('Bağlantı adresi mongodb:// ya da mongodb+srv:// ile başlamalı');
  const [, scheme, user, pass, hostPart, db, qs] = m; const opts = Object.fromEntries(new URLSearchParams(qs || ''));
  let hosts = hostPart.split(',').map(h => { const x = h.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/); return { host: x[1], port: Number(x[2]) || 27017 }; });
  let tlsOn = opts.tls ?? opts.ssl;
  if (scheme === 'mongodb+srv') {
    const name = hosts[0].host;
    let srv; try { srv = await dns.resolveSrv(`_mongodb._tcp.${name}`); } catch (e) { throw new Error(`${name} için SRV kaydı bulunamadı (${e.code || e.message})`); }
    hosts = srv.map(r => ({ host: r.name, port: r.port }));
    try { for (const t of await dns.resolveTxt(name)) Object.assign(opts, Object.fromEntries(new URLSearchParams(t.join(''))), Object.fromEntries(new URLSearchParams(qs || ''))); } catch {}
    tlsOn ??= 'true';
  }
  return { hosts, user: user != null ? decodeURIComponent(user) : '', password: pass != null ? decodeURIComponent(pass) : '', db: decodeURIComponent(db || '') || 'test', authSource: opts.authSource || (user ? decodeURIComponent(db || '') || 'admin' : ''), mechanism: opts.authMechanism || '', tls: tlsOn === 'true', insecure: opts.tlsInsecure === 'true' || opts.tlsAllowInvalidCertificates === 'true' };
}

/* ---------- wire ---------- */
function socketTo({ host, port }, useTls, insecure, timeout) {
  return new Promise((res, rej) => {
    const s = useTls ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !insecure }) : net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); rej(new Error(`${host}:${port} zamanında yanıt vermedi`)); }, timeout);
    s.once(useTls ? 'secureConnect' : 'connect', () => { clearTimeout(t); res(s); });
    s.once('error', e => { clearTimeout(t); rej(new Error(`${host}:${port} bağlantısı kurulamadı: ${e.code || e.message}`)); });
  });
}
function wire(sock, timeout) {
  let buf = Buffer.alloc(0); let reqId = 0; const waiting = new Map(); let dead = null;
  const failAll = e => { dead ??= e; for (const w of waiting.values()) w.rej(dead); waiting.clear(); };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
      const len = buf.readInt32LE(0); const msg = buf.subarray(0, len); buf = buf.subarray(len);
      const to = msg.readInt32LE(8); const op = msg.readInt32LE(12); const w = waiting.get(to); if (!w) continue; waiting.delete(to); clearTimeout(w.t);
      try {
        if (op !== 2013) throw new Error(`Beklenmeyen MongoDB yanıtı (${op})`);
        let i = 20; let doc = null; while (i < len) { const kind = msg[i++]; if (kind === 0) { doc = decode(msg, i); i += msg.readInt32LE(i); } else { i += msg.readInt32LE(i); } }
        w.res(doc);
      } catch (e) { w.rej(e); }
    }
  });
  sock.on('error', e => failAll(new Error(`MongoDB bağlantı hatası: ${e.message}`)));
  sock.on('close', () => failAll(new Error('MongoDB bağlantısı kapandı')));
  return (doc) => new Promise((res, rej) => {
    if (dead) return rej(dead);
    const id = ++reqId; const body = encode(doc); const head = Buffer.alloc(21);
    head.writeInt32LE(21 + body.length, 0); head.writeInt32LE(id, 4); head.writeInt32LE(0, 8); head.writeInt32LE(2013, 12); head.writeUInt32LE(0, 16); head[20] = 0;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error('MongoDB zamanında yanıt vermedi')); }, timeout);
    waiting.set(id, { res, rej, t }); sock.write(Buffer.concat([head, body]));
  });
}

/* ---------- SCRAM ---------- */
const H = (alg, d) => crypto.createHash(alg).update(d).digest();
const HMAC = (alg, k, d) => crypto.createHmac(alg, k).update(d).digest();
function scramProof({ alg, user, password, clientNonce, serverFirst }) {
  const attrs = Object.fromEntries(serverFirst.split(',').map(x => [x[0], x.slice(2)]));
  if (attrs.e) throw new Error(attrs.e);
  if (!attrs.r?.startsWith(clientNonce)) throw new Error('Sunucunun SCRAM yanıtı geçersiz');
  const pass = alg === 'sha1' ? crypto.createHash('md5').update(`${user}:mongo:${password}`).digest('hex') : password.normalize('NFKC');
  const salted = crypto.pbkdf2Sync(pass, Buffer.from(attrs.s, 'base64'), Number(attrs.i), alg === 'sha1' ? 20 : 32, alg);
  const clientKey = HMAC(alg, salted, 'Client Key'); const storedKey = H(alg, clientKey);
  const bare = `n=${user.replace(/=/g, '=3D').replace(/,/g, '=2C')},r=${clientNonce}`;
  const without = `c=biws,r=${attrs.r}`; const authMsg = `${bare},${serverFirst},${without}`;
  const sig = HMAC(alg, storedKey, authMsg); const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
  return { final: `${without},p=${proof.toString('base64')}`, serverSig: HMAC(alg, HMAC(alg, salted, 'Server Key'), authMsg).toString('base64') };
}
async function auth(cmd, { user, password, authSource, mechanism }) {
  const run = async mech => {
    const alg = mech === 'SCRAM-SHA-1' ? 'sha1' : 'sha256'; const clientNonce = crypto.randomBytes(24).toString('base64');
    const first = `n,,n=${user.replace(/=/g, '=3D').replace(/,/g, '=2C')},r=${clientNonce}`;
    let r = await cmd({ saslStart: 1, mechanism: mech, payload: Buffer.from(first), autoAuthorize: 1, options: { skipEmptyExchange: true }, $db: authSource });
    if (r.ok !== 1) throw Object.assign(new Error(r.errmsg || 'giriş başarısız'), { code: r.code });
    const { final, serverSig } = scramProof({ alg, user, password, clientNonce, serverFirst: Buffer.from(r.payload).toString() });
    r = await cmd({ saslContinue: 1, conversationId: r.conversationId, payload: Buffer.from(final), $db: authSource });
    if (r.ok !== 1) throw Object.assign(new Error(r.errmsg || 'giriş başarısız'), { code: r.code });
    const v = Object.fromEntries(Buffer.from(r.payload).toString().split(',').map(x => [x[0], x.slice(2)]));
    if (v.v !== serverSig) throw new Error('Sunucu kimliği doğrulanamadı (SCRAM imzası tutmuyor)');
    if (!r.done) { r = await cmd({ saslContinue: 1, conversationId: r.conversationId, payload: Buffer.alloc(0), $db: authSource }); if (r.ok !== 1) throw new Error(r.errmsg); }
  };
  try { await run(mechanism || 'SCRAM-SHA-256'); }
  catch (e) {
    if (!mechanism && /mechanism|SCRAM-SHA-256/i.test(e.message) && e.code !== 18) { await run('SCRAM-SHA-1'); return; }
    throw new Error(`MongoDB girişi başarısız: ${e.code === 18 ? 'kullanıcı adı ya da şifre yanlış' : e.message}`);
  }
}

async function connect(uri, { timeout = 20000 } = {}) {
  const o = await parseUri(uri); let lastErr;
  const open = async h => {
    const sock = await socketTo(h, o.tls, o.insecure, timeout); const cmd = wire(sock, timeout);
    let hello = await cmd({ hello: 1, $db: 'admin' }).catch(() => null);
    if (!hello || hello.ok !== 1) hello = await cmd({ isMaster: 1, $db: 'admin' });
    return { sock, cmd, hello };
  };
  for (const h of o.hosts) {
    let c;
    try { c = await open(h); } catch (e) { lastErr = e; continue; }
    const primary = c.hello.isWritablePrimary ?? c.hello.ismaster;
    if (!primary && c.hello.primary && o.hosts.length >= 1 && c.hello.setName) {
      const [host, port] = c.hello.primary.split(':'); c.sock.destroy();
      try { c = await open({ host, port: Number(port) || 27017 }); } catch (e) { lastErr = e; continue; }
    }
    try { if (o.user) await auth(c.cmd, o); } catch (e) { c.sock.destroy(); throw e; }
    const run = async (doc, db = o.db) => { const r = await c.cmd({ ...doc, $db: db }); if (r.ok !== 1) throw new Error(`MongoDB: ${r.errmsg || r.codeName || 'komut başarısız'}`); if (r.writeErrors?.length) throw new Error(`MongoDB: ${r.writeErrors[0].errmsg}`); return r; };
    return {
      db: o.db, hello: c.hello, run,
      async cursor(first, coll, db, max = Infinity) {
        const out = [...first.cursor.firstBatch]; let id = first.cursor.id;
        while (id && id !== 0 && out.length < max) { const r = await run({ getMore: typeof id === 'string' ? BigInt(id) : BigInt(id), collection: coll, batchSize: Math.min(1000, max - out.length) }, db); out.push(...r.cursor.nextBatch); id = r.cursor.id; }
        if (id && id !== 0) await run({ killCursors: coll, cursors: [typeof id === 'string' ? BigInt(id) : BigInt(id)] }, db).catch(() => {});
        return out.slice(0, max);
      },
      close() { try { c.sock.end(); } catch {} },
    };
  }
  throw lastErr || new Error('MongoDB sunucusuna bağlanılamadı');
}

module.exports = { connect, encode, decode, ObjectId, fromJSON, toJSON, parseUri, scramProof };
