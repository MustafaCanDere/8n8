'use strict';
/* Minimal IMAP4rev1 client for the e-mail trigger: TLS (993) or STARTTLS (143), LOGIN, SELECT,
   UID SEARCH / FETCH / STORE. Responses are read with literal ({n}) support. */
const net = require('net');
const tls = require('tls');

const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function connect({ host, port = 993, secure = true, user, password, rejectUnauthorized = true }, { timeout = 30000 } = {}) {
  port = Number(port) || 993;
  const implicit = secure === true || secure === 'true' || port === 993;
  return new Promise((resolve, reject) => {
    let sock = implicit ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    let buf = Buffer.alloc(0); let tagN = 0; let pending = null; let greeting = null; let dead = null;
    const timer = setTimeout(() => fail(new Error('E-posta sunucusu zamanında yanıt vermedi')), timeout);
    const fail = e => { if (dead) return; dead = e; clearTimeout(timer); try { sock.destroy(); } catch {} if (pending) { const p = pending; pending = null; p.reject(e); } else reject(e); };
    // collect untagged lines; a line ending with {n} is followed by n raw bytes
    let lines = [];
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        let line = buf.slice(0, nl).toString('latin1'); let used = nl + 2;
        const parts = [line];
        const lits = [];
        let m;
        while ((m = parts[parts.length - 1].match(/\{(\d+)\}$/))) {
          const n = Number(m[1]); if (buf.length < used + n) return; // wait for more
          lits.push(buf.slice(used, used + n)); used += n;
          const nl2 = buf.indexOf('\r\n', used); if (nl2 < 0) return;
          parts.push(buf.slice(used, nl2).toString('latin1')); used = nl2 + 2;
        }
        buf = buf.slice(used);
        const entry = { text: parts.join(' '), lits };
        if (!greeting) { greeting = entry.text; if (!/^\* (OK|PREAUTH)/i.test(greeting)) return fail(new Error(`IMAP: ${greeting}`)); start(); continue; }
        if (pending && entry.text.startsWith(pending.tag + ' ')) {
          const p = pending; pending = null; const got = lines; lines = [];
          if (/^\S+ OK/i.test(entry.text)) p.resolve(got); else p.reject(new Error(`IMAP: ${entry.text.replace(/^\S+ /, '')}`));
        } else lines.push(entry);
      }
    };
    const attach = s => { s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new Error('E-posta sunucusu bağlantıyı kapattı'))); };
    attach(sock);
    const cmd = (line, secret) => new Promise((res, rej) => {
      if (dead) return rej(dead);
      const tag = `A${++tagN}`; pending = { tag, resolve: res, reject: rej, secret };
      sock.write(`${tag} ${line}\r\n`);
    });
    async function start() {
      try {
        let caps = (await cmd('CAPABILITY')).map(l => l.text).join(' ');
        if (!implicit && /STARTTLS/i.test(caps)) {
          await cmd('STARTTLS');
          sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close');
          sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized }); attach(sock);
          await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
          caps = (await cmd('CAPABILITY')).map(l => l.text).join(' ');
        }
        await cmd(`LOGIN ${q(user)} ${q(password || '')}`).catch(e => { throw new Error(`E-posta girişi başarısız: ${e.message.replace(/^IMAP: /, '')}`); });
        clearTimeout(timer);
        resolve(client);
      } catch (e) { fail(e); }
    }
    const client = {
      async select(box = 'INBOX') {
        const r = await cmd(`SELECT ${q(box)}`);
        const t = r.map(l => l.text).join('\n');
        return { uidValidity: Number(t.match(/UIDVALIDITY (\d+)/i)?.[1] || 0), uidNext: Number(t.match(/UIDNEXT (\d+)/i)?.[1] || 0), exists: Number(t.match(/\* (\d+) EXISTS/i)?.[1] || 0) };
      },
      async search(criteria) {
        const r = await cmd(`UID SEARCH ${criteria}`);
        return r.filter(l => /^\* SEARCH/i.test(l.text)).flatMap(l => l.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number));
      },
      async fetch(uids) { // -> [{ uid, raw, flags }]
        if (!uids.length) return [];
        const r = await cmd(`UID FETCH ${uids.join(',')} (UID FLAGS BODY.PEEK[])`);
        return r.filter(l => / FETCH /i.test(l.text) && l.lits.length).map(l => ({ uid: Number(l.text.match(/UID (\d+)/i)?.[1]), flags: (l.text.match(/FLAGS \(([^)]*)\)/i)?.[1] || '').split(/\s+/).filter(Boolean), raw: l.lits[l.lits.length - 1] }));
      },
      async addFlags(uids, flags) { if (uids.length) await cmd(`UID STORE ${uids.join(',')} +FLAGS.SILENT (${flags})`); },
      async logout() { try { await cmd('LOGOUT'); } catch {} try { sock.end(); } catch {} clearTimeout(timer); },
    };
  });
}

module.exports = { connect };
