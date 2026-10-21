'use strict';
/* Minimal Redis client (RESP2): TCP or TLS, AUTH (password or ACL user), SELECT, pipelined commands. */
const net = require('net');
const tls = require('tls');

function encode(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) { const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a)); parts.push(`$${b.length}\r\n`, b, '\r\n'); }
  return Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}
/* parse one reply from buf at offset -> [value, nextOffset] or null when incomplete */
function parse(buf, i = 0) {
  if (i >= buf.length) return null;
  const nl = buf.indexOf('\r\n', i); if (nl < 0) return null;
  const t = String.fromCharCode(buf[i]); const line = buf.toString('utf8', i + 1, nl); let p = nl + 2;
  if (t === '+') return [line, p];
  if (t === '-') return [Object.assign(new Error(line), { redis: true }), p];
  if (t === ':') return [Number(line), p];
  if (t === '$') { const n = Number(line); if (n < 0) return [null, p]; if (buf.length < p + n + 2) return null; return [buf.toString('utf8', p, p + n), p + n + 2]; }
  if (t === '*') {
    const n = Number(line); if (n < 0) return [null, p]; const arr = [];
    for (let k = 0; k < n; k++) { const r = parse(buf, p); if (!r) return null; arr.push(r[0]); p = r[1]; }
    return [arr, p];
  }
  throw new Error(`Redis yanıtı anlaşılamadı: ${line.slice(0, 50)}`);
}

function connect({ host = '127.0.0.1', port = 6379, user, password, db = 0, secure = false, rejectUnauthorized = true }, { timeout = 15000 } = {}) {
  secure = secure === true || secure === 'true';
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port: Number(port) || 6379, servername: host, rejectUnauthorized }) : net.connect({ host, port: Number(port) || 6379 });
    let buf = Buffer.alloc(0); const pending = []; let dead = null;
    const timer = setTimeout(() => fail(new Error('Redis sunucusu zamanında yanıt vermedi')), timeout);
    const fail = e => { if (dead) return; dead = e; clearTimeout(timer); try { sock.destroy(); } catch {} while (pending.length) pending.shift().reject(e); reject(e); };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) { const r = parse(buf); if (!r) break; buf = buf.slice(r[1]); const w = pending.shift(); if (w) (r[0] instanceof Error ? w.reject(new Error(`Redis: ${r[0].message}`)) : w.resolve(r[0])); }
    });
    sock.on('error', fail); sock.on('close', () => fail(new Error('Redis bağlantısı kapandı')));
    const call = (...args) => new Promise((res, rej) => { if (dead) return rej(dead); pending.push({ resolve: res, reject: rej }); sock.write(encode(args.flat())); });
    sock.once(secure ? 'secureConnect' : 'connect', async () => {
      try {
        if (password) await call(...(user ? ['AUTH', user, password] : ['AUTH', password])).catch(e => { throw new Error(`Redis girişi başarısız: ${e.message.replace(/^Redis: /, '')}`); });
        if (Number(db)) await call('SELECT', Number(db));
        clearTimeout(timer);
        resolve({ call, async close() { try { await call('QUIT'); } catch {} try { sock.end(); } catch {} } });
      } catch (e) { fail(e); }
    });
  });
}

module.exports = { connect, encode, parse };
