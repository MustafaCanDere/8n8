'use strict';
/* Minimal FTP client: plain or explicit TLS (AUTH TLS), passive mode (EPSV, falls back to PASV), binary
   transfers, MLSD listing with LIST fallback. One command at a time. */
const net = require('net');
const tls = require('tls');

function connect({ host, port = 21, user = 'anonymous', password = '', secure = false, rejectUnauthorized = true }, { timeout = 30000 } = {}) {
  port = Number(port) || 21; secure = secure === true || secure === 'true';
  return new Promise((resolve, reject) => {
    let sock = net.connect({ host, port }); let buf = ''; let waiter = null; let dead = null; const queue = [];
    const timer = setTimeout(() => fail(new Error('FTP sunucusu zamanında yanıt vermedi')), timeout);
    const fail = e => { if (dead) return; dead = e; clearTimeout(timer); try { sock.destroy(); } catch {} if (waiter) { const w = waiter; waiter = null; w.reject(e); } else reject(e); };
    const onData = d => {
      buf += d.toString('utf8');
      for (;;) { // a reply ends with "ddd " at the start of a line
        const m = buf.match(/(?:^|\r?\n)(\d{3}) [^\r\n]*\r?\n/); if (!m) return;
        const end = m.index + m[0].length; const text = buf.slice(0, end).trim(); buf = buf.slice(end);
        const r = { code: Number(m[1]), text };
        if (waiter) { const w = waiter; waiter = null; w.resolve(r); } else queue.push(r);
      }
    };
    const attach = s => { s.on('data', onData); s.on('error', fail); s.on('close', () => fail(new Error('FTP bağlantısı kapandı'))); };
    attach(sock);
    const read = () => new Promise((res, rej) => { if (dead) return rej(dead); if (queue.length) return res(queue.shift()); waiter = { resolve: res, reject: rej }; });
    const cmd = async (line, ok = /^[23]/) => {
      if (dead) throw dead; sock.write(`${line}\r\n`); const r = await read();
      if (!ok.test(String(r.code))) throw Object.assign(new Error(`FTP: ${r.text.replace(/^\d{3}[ -]/, '')}`), { code: r.code });
      return r;
    };
    const dataSocket = async () => {
      // the data connection always goes to the control host: servers behind NAT often announce a private address
      const h = host; let p;
      try { const r = await cmd('EPSV'); p = Number(r.text.match(/\(\|\|\|(\d+)\|\)/)[1]); }
      catch { const r = await cmd('PASV'); const n = r.text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/).slice(1).map(Number); p = n[4] * 256 + n[5]; }
      return new Promise((res, rej) => {
        const raw = net.connect({ host: h, port: p }, () => {
          if (!secure) return res(raw);
          const s = tls.connect({ socket: raw, servername: host, session: sock.getSession?.(), rejectUnauthorized }, () => res(s)); s.on('error', rej);
        });
        raw.on('error', rej);
      });
    };
    const transfer = async (line, upload) => { // -> Buffer (download/list) or undefined (upload)
      const ds = await dataSocket();
      const chunks = []; const done = new Promise((res, rej) => { ds.on('data', d => chunks.push(d)); ds.on('end', res); ds.on('close', res); ds.on('error', rej); });
      await cmd(line, /^1/);
      if (upload) { await new Promise((res, rej) => ds.end(upload, e => (e ? rej(e) : res()))); }
      await done; const r = await read();
      if (!/^2/.test(String(r.code))) throw new Error(`FTP: ${r.text.replace(/^\d{3}[ -]/, '')}`);
      return upload ? undefined : Buffer.concat(chunks);
    };
    (async () => {
      try {
        const g = await read(); if (g.code !== 220) throw new Error(`FTP: ${g.text}`);
        if (secure) {
          await cmd('AUTH TLS');
          sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close');
          sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized }); attach(sock);
          await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
          await cmd('PBSZ 0'); await cmd('PROT P');
        }
        const u = await cmd(`USER ${user}`, /^[23]/);
        if (u.code === 331) await cmd(`PASS ${password}`).catch(e => { throw new Error(`FTP girişi başarısız: ${e.message.replace(/^FTP: /, '')}`); });
        await cmd('TYPE I');
        let mlsd = false; try { mlsd = /MLST/i.test((await cmd('FEAT')).text); } catch {}
        clearTimeout(timer);
        resolve({
          async list(dir = '.') {
            if (mlsd) {
              const t = (await transfer(`MLSD ${dir}`)).toString('utf8');
              return t.split(/\r?\n/).filter(Boolean).map(l => { const i = l.indexOf(' '); const f = Object.fromEntries(l.slice(0, i).split(';').filter(Boolean).map(x => x.split('=')).map(([k, v]) => [k.toLowerCase(), v])); return { ad: l.slice(i + 1), tur: f.type === 'dir' ? 'klasor' : f.type === 'file' ? 'dosya' : f.type, boyut: f.size != null ? Number(f.size) : null, degisti: f.modify ? `${f.modify.slice(0, 4)}-${f.modify.slice(4, 6)}-${f.modify.slice(6, 8)}T${f.modify.slice(8, 10)}:${f.modify.slice(10, 12)}:${f.modify.slice(12, 14)}Z` : null }; })
                .filter(x => x.tur === 'dosya' || x.tur === 'klasor');
            }
            const t = (await transfer(`LIST ${dir}`)).toString('utf8');
            return t.split(/\r?\n/).filter(l => /^[-dl]/.test(l)).map(l => { const p = l.split(/\s+/); return { ad: p.slice(8).join(' ').replace(/ -> .*$/, ''), tur: l[0] === 'd' ? 'klasor' : 'dosya', boyut: Number(p[4]) || 0, degisti: null }; });
          },
          download: p => transfer(`RETR ${p}`),
          upload: (p, data) => transfer(`STOR ${p}`, data),
          remove: p => cmd(`DELE ${p}`),
          rename: (a, b) => cmd(`RNFR ${a}`, /^3/).then(() => cmd(`RNTO ${b}`)),
          async mkdirs(dir) { let cur = dir.startsWith('/') ? '' : '.'; for (const part of dir.split('/').filter(Boolean)) { cur = `${cur}/${part}`; await cmd(`MKD ${cur}`, /^[25]/).catch(() => {}); } },
          async close() { try { await cmd('QUIT'); } catch {} try { sock.end(); } catch {} },
        });
      } catch (e) { fail(e); }
    })();
  });
}

module.exports = { connect };
