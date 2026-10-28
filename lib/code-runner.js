'use strict';
/* Runs Kod node JavaScript in a separate Node process under Node's permission model:
   no file system, no child processes, no worker threads, no native addons, an empty
   environment (so API keys and the encryption key are not visible) and a memory cap.
   Network (fetch) stays available. N8N8_CODE_SANDBOX=0 runs code in-process instead (faster, not isolated). */
const { spawn } = require('child_process');
const vm = require('vm');
const path = require('path');
const { inSea } = require('./sea');

const FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : null;
const ENABLED = () => FLAG && process.env.N8N8_CODE_SANDBOX !== '0';

const CHILD = path.join(__dirname, 'code-child.js');
const READABLE = [CHILD, path.join(__dirname, 'expr.js')];

function runInProcess({ code, filename, items, nm, vars, execution, workflow, ms, log, helpers }) {
  const consoleProxy = { log: (...a) => log(...a), info: (...a) => log(...a), warn: (...a) => log('⚠', ...a), error: (...a) => log('✖', ...a) };
  const sandbox = { items, $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1] }, $node: nm, $vars: vars, $execution: execution, $workflow: workflow, console: consoleProxy, fetch, URL, URLSearchParams, setTimeout, clearTimeout, Buffer, helpers };
  let script;
  try { script = new vm.Script(`(async () => {\n${code}\n})()`, { filename }); }
  catch (e) { throw new Error(`Sözdizimi hatası: ${e.message}`); }
  const promise = script.runInNewContext(sandbox, { timeout: ms });
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Kod ${ms / 1000} sn içinde bitmedi`)), ms); })]).finally(() => clearTimeout(timer));
}

function runSandboxed({ code, filename, items, nm, vars, execution, workflow, ms, log, signal, memoryMb = Number(process.env.N8N8_CODE_MEMORY_MB) || 256 }) {
  return new Promise((resolve, reject) => {
    // inside Auto-Move.exe the child is the exe itself; it takes its Node flags from NODE_OPTIONS and its code is embedded
    const child = inSea
      ? spawn(process.execPath, [], { env: { N8N8_CODE_CHILD: '1', NODE_OPTIONS: `${FLAG} --max-old-space-size=${memoryMb} --no-warnings` }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(process.execPath, [FLAG, ...READABLE.map(f => `--allow-fs-read=${f}`), `--max-old-space-size=${memoryMb}`, '--no-warnings', CHILD], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let done = false, rest = '', err = '';
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); try { child.kill('SIGKILL'); } catch {} fn(v); };
    const timer = setTimeout(() => finish(reject, new Error(`Kod ${ms / 1000} sn içinde bitmedi`)), ms);
    const onAbort = () => finish(reject, new Error('Çalıştırma durduruldu'));
    signal?.addEventListener?.('abort', onAbort);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      rest += d; let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i); rest = rest.slice(i + 1); if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if ('log' in m) log(m.log);
        else if ('error' in m) finish(reject, new Error(m.error));
        else if ('result' in m) finish(resolve, m.result);
      }
    });
    child.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', e => finish(reject, new Error('Kod çalıştırılamadı: ' + e.message)));
    child.on('close', (codeNum, sig) => {
      if (done) return;
      const oom = /heap out of memory|Allocation failed/i.test(err);
      finish(reject, new Error(oom ? `Kod bellek sınırını (${memoryMb} MB) aştı` : `Kod beklenmedik şekilde sonlandı${err ? ': ' + err.trim().split('\n').slice(-1)[0] : ` (${sig || codeNum})`}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ code, filename, items, nm, vars, execution, workflow, ms }));
  });
}

async function runCode(opts) {
  if (ENABLED()) return runSandboxed(opts);
  // the in-process fallback is not isolated, so it only runs when the user turned the sandbox off on purpose
  if (process.env.N8N8_CODE_SANDBOX === '0') return runInProcess(opts);
  throw new Error(`Kod node'unun güvenli çalışması için Node.js 20 ya da daha yeni bir sürüm gerekir (şu an ${process.version}). Node.js'i güncelleyin.`);
}

module.exports = { runCode, sandboxed: () => !!ENABLED() };
