'use strict';
/* Minimal MQTT 3.1.1 client over TCP or TLS: connect (user/password), publish (QoS 0/1, retain), subscribe with
   message callback, keep-alive pings. Used by the MQTT node and the MQTT trigger. */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const CONNACK = { 1: 'protokol sürümü desteklenmiyor', 2: 'istemci kimliği reddedildi', 3: 'sunucu şu an hizmet vermiyor', 4: 'kullanıcı adı ya da şifre yanlış', 5: 'yetkiniz yok (kullanıcı adı ya da şifre yanlış olabilir)' };

const str = s => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
function packet(type, flags, body) {
  const len = []; let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
  return Buffer.concat([Buffer.from([(type << 4) | flags, ...len]), body]);
}
/* topic filter match: + one level, # the rest */
function matches(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) { if (f[i] === '#') return true; if (i >= t.length) return false; if (f[i] !== '+' && f[i] !== t[i]) return false; }
  return f.length === t.length;
}

function connect({ host, port, user, password, secure, rejectUnauthorized = true, clientId, keepalive = 60 }, { timeout = 15000, onMessage, onClose } = {}) {
  secure = secure === true || secure === 'true';
  port = Number(port) || (secure ? 8883 : 1883);
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }) : net.connect({ host, port });
    let buf = Buffer.alloc(0); let nextId = 1; const acks = new Map(); let ready = false; let dead = null; let ping;
    const timer = setTimeout(() => fail(new Error('MQTT sunucusu zamanında yanıt vermedi')), timeout);
    const fail = e => {
      if (dead) return; dead = e; clearTimeout(timer); clearInterval(ping); try { sock.destroy(); } catch {}
      for (const a of acks.values()) a.rej(e); acks.clear();
      if (!ready) reject(e); else onClose?.(e);
    };
    const wait = id => new Promise((res, rej) => { const t = setTimeout(() => { acks.delete(id); rej(new Error('MQTT sunucusu onay vermedi')); }, timeout); acks.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } }); });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let mul = 1, len = 0, i = 1, byte;
        do { if (i >= buf.length) return; byte = buf[i++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.subarray(i, i + len); buf = buf.subarray(i + len);
        if (type === 2) { // CONNACK
          if (body[1] !== 0) return fail(new Error(`MQTT bağlantısı reddedildi: ${CONNACK[body[1]] || body[1]}`));
          ready = true; clearTimeout(timer);
          ping = setInterval(() => { if (!dead) sock.write(Buffer.from([0xc0, 0])); }, Math.max(5, keepalive - 5) * 1000); ping.unref?.();
          resolve(api);
        } else if (type === 3) { // PUBLISH
          const qos = (flags >> 1) & 3; const tl = body.readUInt16BE(0); const topic = body.toString('utf8', 2, 2 + tl); let p = 2 + tl;
          if (qos > 0) { const id = body.readUInt16BE(p); p += 2; sock.write(packet(qos === 1 ? 4 : 5, 0, Buffer.from([id >> 8, id & 255]))); }
          onMessage?.({ topic, payload: Buffer.from(body.subarray(p)), retain: !!(flags & 1), qos });
        } else if (type === 4 || type === 9 || type === 11) { // PUBACK, SUBACK, UNSUBACK
          const id = body.readUInt16BE(0); const a = acks.get(id); if (!a) continue; acks.delete(id);
          if (type === 9 && [...body.subarray(2)].some(x => x === 0x80)) a.rej(new Error('MQTT sunucusu aboneliği reddetti (konu izni yok)')); else a.res([...body.subarray(2)]);
        } else if (type === 5) { const id = body.readUInt16BE(0); sock.write(packet(6, 2, Buffer.from([id >> 8, id & 255]))); } // PUBREC -> PUBREL
        else if (type === 7) { const id = body.readUInt16BE(0); const a = acks.get(id); if (a) { acks.delete(id); a.res([]); } } // PUBCOMP
        else if (type === 6) { const id = body.readUInt16BE(0); sock.write(packet(7, 0, Buffer.from([id >> 8, id & 255]))); }
      }
    });
    sock.on('error', e => fail(new Error(`MQTT bağlantı hatası: ${e.code || e.message}`)));
    sock.on('close', () => fail(new Error('MQTT bağlantısı kapandı')));
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      const id = clientId || `8n8-${crypto.randomBytes(6).toString('hex')}`;
      const flagsByte = 0x02 | (user ? 0x80 : 0) | (user && password ? 0x40 : 0);
      const ka = Buffer.alloc(2); ka.writeUInt16BE(keepalive);
      sock.write(packet(1, 0, Buffer.concat([str('MQTT'), Buffer.from([4, flagsByte]), ka, str(id), ...(user ? [str(user)] : []), ...(user && password ? [str(password)] : [])])));
    });
    const newId = () => { const id = nextId; nextId = nextId >= 65535 ? 1 : nextId + 1; return id; };
    const api = {
      async publish(topic, payload, { qos = 0, retain = false } = {}) {
        if (dead) throw dead; qos = Math.min(2, Math.max(0, Number(qos) || 0));
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
        const id = qos ? newId() : 0; const pid = qos ? Buffer.from([id >> 8, id & 255]) : Buffer.alloc(0);
        const done = qos ? wait(id) : null;
        sock.write(packet(3, (qos << 1) | (retain ? 1 : 0), Buffer.concat([str(topic), pid, data])));
        if (done) await done;
      },
      async subscribe(topics, qos = 0) {
        if (dead) throw dead; const id = newId(); const done = wait(id);
        sock.write(packet(8, 2, Buffer.concat([Buffer.from([id >> 8, id & 255]), ...[].concat(topics).flatMap(t => [str(t), Buffer.from([Math.min(1, Number(qos) || 0)])])])));
        return done;
      },
      get closed() { return !!dead; },
      async close() { if (dead) return; try { sock.write(Buffer.from([0xe0, 0])); } catch {} dead = new Error('kapatıldı'); clearInterval(ping); for (const a of acks.values()) a.rej(dead); acks.clear(); try { sock.end(); } catch {} },
    };
  });
}

module.exports = { connect, matches };
