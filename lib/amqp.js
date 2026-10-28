'use strict';
/* Minimal AMQP 0-9-1 client (RabbitMQ, LavinMQ, CloudAMQP): PLAIN login, one channel, publisher confirms,
   queue/exchange declare and bind, publish, basic.get with ack. Enough for the RabbitMQ node and its polling trigger. */
const net = require('net');
const tls = require('tls');

/* ---------- encoding ---------- */
const u8 = n => Buffer.from([n]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const shortstr = s => { const b = Buffer.from(String(s ?? ''), 'utf8'); if (b.length > 255) throw new Error(`AMQP: "${String(s).slice(0, 30)}…" 255 bayttan uzun`); return Buffer.concat([u8(b.length), b]); };
const longstr = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s ?? ''), 'utf8'); return Buffer.concat([u32(b.length), b]); };
function fieldValue(v) {
  if (v == null) return u8(0x56); // 'V'
  if (typeof v === 'boolean') return Buffer.concat([u8(0x74), u8(v ? 1 : 0)]);
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { const b = Buffer.alloc(4); b.writeInt32BE(v); return Buffer.concat([u8(0x49), b]); }
    if (Number.isSafeInteger(v)) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return Buffer.concat([u8(0x6c), b]); }
    const b = Buffer.alloc(8); b.writeDoubleBE(v); return Buffer.concat([u8(0x64), b]);
  }
  if (Array.isArray(v)) { const inner = Buffer.concat(v.map(fieldValue)); return Buffer.concat([u8(0x41), u32(inner.length), inner]); }
  if (typeof v === 'object') return Buffer.concat([u8(0x46), table(v)]);
  return Buffer.concat([u8(0x53), longstr(v)]);
}
function table(o = {}) { const inner = Buffer.concat(Object.entries(o).map(([k, v]) => Buffer.concat([shortstr(k), fieldValue(v)]))); return Buffer.concat([u32(inner.length), inner]); }

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8() { return this.b[this.i++]; }
  u16() { const v = this.b.readUInt16BE(this.i); this.i += 2; return v; }
  u32() { const v = this.b.readUInt32BE(this.i); this.i += 4; return v; }
  u64() { const v = this.b.readBigUInt64BE(this.i); this.i += 8; return v; }
  shortstr() { const n = this.u8(); const s = this.b.toString('utf8', this.i, this.i + n); this.i += n; return s; }
  longstr() { const n = this.u32(); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  value() {
    const t = String.fromCharCode(this.u8());
    switch (t) {
      case 't': return this.u8() !== 0;
      case 'b': { const v = this.b.readInt8(this.i); this.i += 1; return v; }
      case 'B': return this.u8();
      case 's': { const v = this.b.readInt16BE(this.i); this.i += 2; return v; }
      case 'u': return this.u16();
      case 'I': { const v = this.b.readInt32BE(this.i); this.i += 4; return v; }
      case 'i': return this.u32();
      case 'l': case 'L': { const v = this.b.readBigInt64BE(this.i); this.i += 8; return Number(v); }
      case 'f': { const v = this.b.readFloatBE(this.i); this.i += 4; return v; }
      case 'd': { const v = this.b.readDoubleBE(this.i); this.i += 8; return v; }
      case 'D': { const scale = this.u8(); const v = this.b.readInt32BE(this.i); this.i += 4; return v / 10 ** scale; }
      case 'S': return this.longstr().toString('utf8');
      case 'x': return this.longstr();
      case 'T': return new Date(Number(this.u64()) * 1000).toISOString();
      case 'F': return this.table();
      case 'A': { const n = this.u32(); const end = this.i + n; const a = []; while (this.i < end) a.push(this.value()); return a; }
      case 'V': return null;
      default: throw new Error(`AMQP alan türü bilinmiyor: ${t}`);
    }
  }
  table() { const n = this.u32(); const end = this.i + n; const o = {}; while (this.i < end) { const k = this.shortstr(); o[k] = this.value(); } return o; }
}

/* content properties in flag order (AMQP 0-9-1 basic class) */
const PROPS = [['contentType', 's'], ['contentEncoding', 's'], ['headers', 'F'], ['deliveryMode', 'o'], ['priority', 'o'], ['correlationId', 's'], ['replyTo', 's'], ['expiration', 's'], ['messageId', 's'], ['timestamp', 'T'], ['type', 's'], ['userId', 's'], ['appId', 's'], ['clusterId', 's']];
function encodeProps(p) {
  let flags = 0; const parts = [];
  PROPS.forEach(([k, t], i) => {
    if (p[k] == null) return; flags |= 1 << (15 - i);
    parts.push(t === 's' ? shortstr(p[k]) : t === 'F' ? table(p[k]) : t === 'o' ? u8(Number(p[k])) : u64(Math.floor((typeof p[k] === 'number' ? p[k] : Date.parse(p[k]) || 0) / 1000)));
  });
  return Buffer.concat([u16(flags), ...parts]);
}
function decodeProps(r) {
  const flags = r.u16(); const p = {};
  PROPS.forEach(([k, t], i) => { if (!(flags & (1 << (15 - i)))) return; p[k] = t === 's' ? r.shortstr() : t === 'F' ? r.table() : t === 'o' ? r.u8() : new Date(Number(r.u64()) * 1000).toISOString(); });
  return p;
}

const REPLY = { 311: 'mesaj çok büyük', 312: 'yönlendirilemedi', 313: 'tüketici yok', 320: 'bağlantı kapatıldı', 403: 'erişim reddedildi (kullanıcının bu sanal sunucuya ya da kaynağa izni yok)', 404: 'bulunamadı', 405: 'kaynak kilitli (başka bir bağlantıya özel)', 406: 'ön koşul başarısız (kuyruk farklı ayarlarla zaten var)', 530: 'izin verilmeyen işlem', 541: 'sunucu iç hatası' };

function connect({ host = 'localhost', port, user = 'guest', password = 'guest', vhost = '/', secure = false, rejectUnauthorized = true }, { timeout = 15000 } = {}) {
  secure = secure === true || secure === 'true'; port = Number(port) || (secure ? 5671 : 5672);
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }) : net.connect({ host, port });
    let buf = Buffer.alloc(0); let dead = null; let ready = false; let frameMax = 131072; let hb = null; let content = null;
    const waiters = []; // { cls, mth, res, rej }
    const timer = setTimeout(() => fail(new Error('RabbitMQ sunucusu zamanında yanıt vermedi')), timeout);
    const fail = e => { if (dead) return; dead = e; clearTimeout(timer); clearInterval(hb); try { sock.destroy(); } catch {} while (waiters.length) waiters.shift().rej(e); if (!ready) reject(e); };
    const frame = (type, ch, payload) => Buffer.concat([u8(type), u16(ch), u32(payload.length), payload, u8(0xce)]);
    const method = (ch, cls, mth, args = Buffer.alloc(0)) => { if (!dead) sock.write(frame(1, ch, Buffer.concat([u16(cls), u16(mth), args]))); };
    const expect = (cls, mth) => new Promise((res, rej) => { if (dead) return rej(dead); waiters.push({ cls, mth: [].concat(mth), res, rej }); });
    const deliver = (cls, mth, r) => {
      const i = waiters.findIndex(w => w.cls === cls && w.mth.includes(mth));
      if (i >= 0) { const [w] = waiters.splice(i, 1); w.res({ mth, r }); }
    };
    const onMethod = (ch, cls, mth, r) => {
      if (cls === 10 && mth === 10) { // Connection.Start
        r.u8(); r.u8(); r.table(); const mechs = r.longstr().toString();
        if (!/\bPLAIN\b/.test(mechs)) return fail(new Error(`RabbitMQ PLAIN girişini desteklemiyor (${mechs})`));
        method(0, 10, 11, Buffer.concat([table({ product: 'Auto-Move', platform: 'Node.js', capabilities: { publisher_confirms: true, 'connection.blocked': false, consumer_cancel_notify: true, authentication_failure_close: true } }), shortstr('PLAIN'), longstr(Buffer.from(`\0${user}\0${password}`)), shortstr('en_US')]));
      } else if (cls === 10 && mth === 30) { // Tune
        const chMax = r.u16(); const fm = r.u32(); const beat = r.u16(); frameMax = fm || 131072; const hbSec = beat ? Math.min(beat, 60) : 60;
        method(0, 10, 31, Buffer.concat([u16(chMax || 2047), u32(frameMax), u16(hbSec)]));
        hb = setInterval(() => { if (!dead) sock.write(frame(8, 0, Buffer.alloc(0))); }, hbSec * 500); hb.unref?.();
        method(0, 10, 40, Buffer.concat([shortstr(vhost), shortstr(''), u8(0)]));
      } else if (cls === 10 && mth === 41) { method(1, 20, 10, shortstr('')); } // Open-Ok -> open channel 1
      else if (cls === 20 && mth === 11) { ready = true; clearTimeout(timer); resolve(api); }
      else if (cls === 10 && mth === 50 || cls === 20 && mth === 40) { // Connection.Close / Channel.Close from server
        const code = r.u16(); const text = r.shortstr();
        method(ch, cls, mth + 1);
        const e = new Error((code === 403 || code === 530) && !ready ? code === 530 ? `RabbitMQ: "${vhost}" sanal sunucusu (vhost) yok ya da izniniz yok` : 'RabbitMQ girişi başarısız: kullanıcı adı, şifre ya da sanal sunucu (vhost) yanlış' : `RabbitMQ: ${REPLY[code] || code}${text ? ` (${text.replace(/^[A-Z_]+ - /, '')})` : ''}`);
        fail(e);
      } else if (cls === 60 && (mth === 71 || mth === 60)) { // Get-Ok / Deliver: content follows
        const m = mth === 71 ? { deliveryTag: r.u64(), redelivered: !!r.u8(), exchange: r.shortstr(), routingKey: r.shortstr(), remaining: r.u32() } : { consumerTag: r.shortstr(), deliveryTag: r.u64(), redelivered: !!r.u8(), exchange: r.shortstr(), routingKey: r.shortstr() };
        content = { m, mth, size: null, chunks: [], got: 0 };
      } else if (cls === 60 && mth === 80) { deliver(cls, mth, r); } // publisher confirm ack
      else if (cls === 60 && mth === 120) { const tag = r.u64(); const w = waiters.findIndex(x => x.cls === 60 && x.mth.includes(80)); if (w >= 0) waiters.splice(w, 1)[0].rej(new Error(`RabbitMQ mesajı reddetti (nack, #${tag})`)); }
      else deliver(cls, mth, r);
    };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const type = buf[0], ch = buf.readUInt16BE(1), size = buf.readUInt32BE(3);
        if (buf.length < size + 8) return;
        const payload = buf.subarray(7, 7 + size); if (buf[7 + size] !== 0xce) return fail(new Error('AMQP çerçevesi bozuk'));
        buf = buf.subarray(size + 8);
        try {
          if (type === 1) { const r = new Reader(payload); onMethod(ch, r.u16(), r.u16(), r); }
          else if (type === 2 && content) { const r = new Reader(payload); r.u16(); r.u16(); content.size = Number(r.u64()); content.props = decodeProps(r); if (!content.size) finish(); }
          else if (type === 3 && content) { content.chunks.push(Buffer.from(payload)); content.got += payload.length; if (content.got >= content.size) finish(); }
        } catch (e) { fail(e); }
      }
    });
    const finish = () => { const c = content; content = null; const msg = { ...c.m, properties: c.props || {}, body: Buffer.concat(c.chunks) }; if (c.mth === 71) deliver(60, 71, msg); else api.onDeliver?.(msg); };
    sock.on('error', e => fail(new Error(`RabbitMQ bağlantı hatası: ${e.code || e.message}`)));
    sock.on('close', () => fail(new Error('RabbitMQ bağlantısı kapandı')));
    sock.once(secure ? 'secureConnect' : 'connect', () => sock.write(Buffer.from('AMQP\x00\x00\x09\x01', 'latin1')));

    let confirming = false; let pubSeq = 0;
    const api = {
      async declareQueue(name, { durable = true, passive = false } = {}) {
        method(1, 50, 10, Buffer.concat([u16(0), shortstr(name), u8((passive ? 1 : 0) | (durable ? 2 : 0)), table({})]));
        const { r } = await expect(50, 11); return { queue: r.shortstr(), messages: r.u32(), consumers: r.u32() };
      },
      async declareExchange(name, type = 'direct', { durable = true, passive = false } = {}) {
        method(1, 40, 10, Buffer.concat([u16(0), shortstr(name), shortstr(type), u8((passive ? 1 : 0) | (durable ? 2 : 0)), table({})])); await expect(40, 11);
      },
      async bind(queue, exchange, key = '') { method(1, 50, 20, Buffer.concat([u16(0), shortstr(queue), shortstr(exchange), shortstr(key), u8(0), table({})])); await expect(50, 21); },
      async publish(exchange, routingKey, body, props = {}) {
        if (!confirming) { method(1, 85, 10, u8(0)); await expect(85, 11); confirming = true; }
        const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        pubSeq++;
        const ack = expect(60, 80);
        const frames = [frame(1, 1, Buffer.concat([u16(60), u16(40), u16(0), shortstr(exchange), shortstr(routingKey), u8(0)])),
          frame(2, 1, Buffer.concat([u16(60), u16(0), u64(data.length), encodeProps(props)]))];
        for (let i = 0; i < data.length; i += frameMax - 8) frames.push(frame(3, 1, data.subarray(i, i + frameMax - 8)));
        if (dead) throw dead; sock.write(Buffer.concat(frames)); await ack; return pubSeq;
      },
      async get(queue, { ack = true } = {}) {
        method(1, 60, 70, Buffer.concat([u16(0), shortstr(queue), u8(ack ? 0 : 1)]));
        const { mth, r } = await expect(60, [71, 72]); return mth === 72 ? null : r;
      },
      ack(tag, multiple = false) { method(1, 60, 80, Buffer.concat([u64(tag), u8(multiple ? 1 : 0)])); },
      nack(tag, requeue = true) { method(1, 60, 120, Buffer.concat([u64(tag), u8(requeue ? 2 : 0)])); },
      async purge(queue) { method(1, 50, 30, Buffer.concat([u16(0), shortstr(queue), u8(0)])); const { r } = await expect(50, 31); return r.u32(); },
      async close() {
        if (dead) return;
        try { method(1, 20, 40, Buffer.concat([u16(200), shortstr('OK'), u16(0), u16(0)])); await Promise.race([expect(20, 41), new Promise(r => setTimeout(r, 1000))]); method(0, 10, 50, Buffer.concat([u16(200), shortstr('OK'), u16(0), u16(0)])); await Promise.race([expect(10, 51), new Promise(r => setTimeout(r, 1000))]); } catch {}
        dead = new Error('kapatıldı'); clearInterval(hb); try { sock.end(); } catch {}
      },
    };
  });
}

module.exports = { connect, table, Reader, encodeProps, decodeProps };
