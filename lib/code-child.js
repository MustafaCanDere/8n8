'use strict';
/* Child process for the Kod node; started by code-runner.js under Node's permission model. */
const vm = require('vm');
const Expr = require('./expr');
let buf = '';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const fmt = a => a.map(x => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(' ');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => buf += d);
process.stdin.on('end', async () => {
  const P = JSON.parse(buf);
  const items = P.items;
  const log = (pre) => (...a) => out({ log: (pre ? pre + ' ' : '') + fmt(a) });
  const helpers = { sleep: ms => new Promise(r => setTimeout(r, ms)), formatDate: Expr.formatDate, addTime: Expr.addTime };
  const sandbox = { items, $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1] }, $node: P.nm, $vars: P.vars, $execution: P.execution, $workflow: P.workflow,
    console: { log: log(''), info: log(''), warn: log('⚠'), error: log('✖') }, fetch, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, structuredClone, atob, btoa, crypto: globalThis.crypto, helpers };
  try {
    let script;
    try { script = new vm.Script('(async () => {\n' + P.code + '\n})()', { filename: P.filename }); }
    catch (e) { return out({ error: 'Sözdizimi hatası: ' + e.message }); }
    const res = await script.runInNewContext(sandbox, { timeout: P.ms });
    out({ result: res === undefined ? null : JSON.parse(JSON.stringify(res)) });
  } catch (e) {
    let msg = e && e.message || String(e);
    if (e && e.code === 'ERR_ACCESS_DENIED') msg = 'Kod node\'u dosyalara, programlara ve sistem kaynaklarına erişemez (' + (e.permission || 'izin yok') + ')';
    out({ error: msg });
  }
  // the parent kills this process once it has read the result
});
