'use strict';
/* AWS Signature Version 4 for S3 and S3-compatible storage (Cloudflare R2, MinIO, Wasabi, DigitalOcean Spaces). */
const crypto = require('crypto');

const sha = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = p => p.split('/').map(enc).join('/');
const amz = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function signingKey(secret, date, region, service) { return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request'); }
function canonicalQuery(q) { return Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&'); }

/* -> headers to send (with Authorization) */
function sign({ method, host, path, query = {}, headers = {}, body, accessKey, secretKey, region = 'us-east-1', service = 's3', date = new Date() }) {
  const t = amz(date), day = t.slice(0, 8);
  const payload = body === 'UNSIGNED-PAYLOAD' ? body : sha(body || '');
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': payload, 'x-amz-date': t };
  const names = Object.keys(h).sort();
  const creq = [method, encPath(path), canonicalQuery(query), ...names.map(n => `${n}:${h[n]}`), '', names.join(';'), payload].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', t, scope, sha(creq)].join('\n');
  const sig = hmac(signingKey(secretKey, day, region, service), sts).toString('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
}
/* query-string signed GET link that works without credentials until it expires */
function presign({ host, path, accessKey, secretKey, region = 'us-east-1', expires = 3600, protocol = 'https:', date = new Date() }) {
  const t = amz(date), day = t.slice(0, 8); const scope = `${day}/${region}/s3/aws4_request`;
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKey}/${scope}`, 'X-Amz-Date': t, 'X-Amz-Expires': String(Math.min(604800, Math.max(1, expires))), 'X-Amz-SignedHeaders': 'host' };
  const creq = ['GET', encPath(path), canonicalQuery(q), `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sig = hmac(signingKey(secretKey, day, region, 's3'), ['AWS4-HMAC-SHA256', t, scope, sha(creq)].join('\n')).toString('hex');
  return `${protocol}//${host}${encPath(path)}?${canonicalQuery({ ...q, 'X-Amz-Signature': sig })}`;
}
/* bucket + key -> { protocol, host, path } for AWS (virtual-hosted) or a custom endpoint (path style) */
function locate({ endpoint, region = 'us-east-1', pathStyle }, bucket, key = '') {
  const k = String(key).replace(/^\/+/, '');
  if (!endpoint) return { protocol: 'https:', host: `${bucket}.s3.${region}.amazonaws.com`, path: `/${k}` };
  const u = new URL(/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`);
  const base = u.pathname.replace(/\/+$/, '');
  if (pathStyle === false || pathStyle === 'false') return { protocol: u.protocol, host: `${bucket}.${u.host}`, path: `${base}/${k}` };
  return { protocol: u.protocol, host: u.host, path: `${base}/${bucket}${k ? `/${k}` : ""}` };
}

module.exports = { sign, presign, locate, sha, encPath };
