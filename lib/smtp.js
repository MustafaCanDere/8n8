'use strict';
/* Minimal SMTP client: implicit TLS (465) or STARTTLS (587/25), AUTH PLAIN/LOGIN, one message. */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`; }
const addr = s => (String(s).match(/<([^>]+)>/) || [null, String(s).trim()])[1];
const list = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', csv: 'text/csv', txt: 'text/plain', json: 'application/json', zip: 'application/zip', ics: 'text/calendar', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html' };
/* attachments: [{ name, data: Buffer, type? }] */
function buildMessage({ from, to, cc, subject, text, html, attachments = [] }) {
  const boundary = `8n8-${crypto.randomBytes(8).toString('hex')}`; const mixed = `8n8m-${crypto.randomBytes(8).toString('hex')}`;
  const b64 = s => (Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8')).toString('base64').replace(/.{76}/g, '$&\r\n');
  const head = [
    `From: ${from}`, `To: ${list(to).join(', ')}`, ...(cc ? [`Cc: ${list(cc).join(', ')}`] : []),
    `Subject: ${encodeHeader(subject || '')}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@8n8.local>`, 'MIME-Version: 1.0',
  ];
  const body = html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text || String(html).replace(/<[^>]+>/g, '')),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html), `--${boundary}--`]
    : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text || '')];
  if (!attachments.length) return [...head, ...body, ''].join('\r\n');
  const parts = attachments.map(a => {
    const name = String(a.name || 'ek').replace(/["\r\n]/g, ''); const type = a.type || MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const enc = /^[\x20-\x7e]*$/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;
    return [`--${mixed}`, `Content-Type: ${type}; name="${encodeHeader(name)}"`, `Content-Disposition: attachment; ${enc}`, 'Content-Transfer-Encoding: base64', '', b64(a.data)].join('\r\n');
  });
  return [...head, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...body, ...parts, `--${mixed}--`, ''].join('\r\n');
}

function sendMail({ host, port = 587, secure, user, password, rejectUnauthorized = true }, mail, { timeout = 30000 } = {}) {
  port = Number(port);
  const implicitTLS = secure === true || secure === 'true' || port === 465;
  return new Promise((resolve, reject) => {
    let sock = implicitTLS ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    let buf = '', waiter = null, done = false;
    const fail = err => { if (done) return; done = true; try { sock.destroy(); } catch {} reject(err instanceof Error ? err : new Error(String(err))); };
    const timer = setTimeout(() => fail(new Error('SMTP sunucusu zamanında yanıt vermedi')), timeout);
    const onData = d => {
      buf += d.toString('utf8');
      // a reply is complete when its last line has "NNN " (space after code)
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null; if (w) w(reply); return;
        }
      }
    };
    const attach = s => { s.on('data', onData); s.on('error', fail); };
    attach(sock);
    const read = () => new Promise(res => { waiter = res; });
    const cmd = async (line, expect) => {
      if (line != null) sock.write(line + '\r\n');
      const r = await read();
      if (!expect.includes(Number(r.slice(0, 3)))) throw new Error(`SMTP: ${line ? line.split(' ')[0] + ' → ' : ''}${r.split('\n').pop()}`);
      return r;
    };
    (async () => {
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO 8n8.local', [250]);
      if (!implicitTLS && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized });
        attach(sock);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = await cmd('EHLO 8n8.local', [250]);
      }
      if (user) {
        if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password || ''}`).toString('base64')}`, [235]);
        else { await cmd('AUTH LOGIN', [334]); await cmd(Buffer.from(user).toString('base64'), [334]); await cmd(Buffer.from(password || '').toString('base64'), [235]); }
      }
      if (!mail) { // connection test only
        try { sock.write('QUIT\r\n'); } catch {}
        clearTimeout(timer); done = true; sock.end(); return resolve({ ok: true });
      }
      await cmd(`MAIL FROM:<${addr(mail.from)}>`, [250]);
      const rcpts = [...list(mail.to), ...list(mail.cc), ...list(mail.bcc)];
      if (!rcpts.length) throw new Error('Alıcı yok');
      for (const r of rcpts) await cmd(`RCPT TO:<${addr(r)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const body = buildMessage(mail).replace(/\r\n\./g, '\r\n..');
      const res = await cmd(body + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch {}
      clearTimeout(timer); done = true; sock.end();
      resolve({ kabul: res.trim(), alicilar: rcpts });
    })().catch(err => { clearTimeout(timer); fail(err); });
  });
}

module.exports = { sendMail, buildMessage };
