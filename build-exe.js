'use strict';
/* Builds Auto-Move.exe (Windows) as a Node.js single executable application:
     npm install --no-save esbuild postject resedit && node build-exe.js
   N8N8_EXE_TARGET=linux builds for this computer instead (used to run the tests against the built program). */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'dist');
const TARGET = process.env.N8N8_EXE_TARGET || 'win';
const pkg = require('./package.json');
const NODE_VERSION = process.version; // the blob must be made by the same Node version as the exe it goes into

function download(url, file) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return download(res.headers.location, file).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`${url}: ${res.statusCode}`));
      const f = fs.createWriteStream(file); res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject);
    }).on('error', reject);
  });
}

// node.exe carries Node's code signature, which the injected blob would leave broken; drop it so the exe is plainly unsigned
function unsign(buf) {
  const pe = buf.readUInt32LE(0x3c), opt = pe + 24;
  const dir = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96) + 4 * 8; // data directory 4: certificate table
  const off = buf.readUInt32LE(dir), size = buf.readUInt32LE(dir + 4);
  buf.writeUInt32LE(0, dir); buf.writeUInt32LE(0, dir + 4);
  return off && off + size === buf.length ? buf.subarray(0, off) : buf;
}

// Auto-Move's icon and name in Explorer and the taskbar instead of Node's
function brand(buf) {
  const R = require('resedit');
  const pe = R.NtExecutable.from(buf), res = R.NtExecutableResource.from(pe);
  const icon = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'public', 'Auto-Move.ico')));
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map(i => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { CompanyName: 'Auto-Move', ProductName: 'Auto-Move', FileDescription: 'Auto-Move iş akışı otomasyonu', FileVersion: pkg.version, ProductVersion: pkg.version, OriginalFilename: 'Auto-Move.exe', InternalName: 'Auto-Move', LegalCopyright: `Auto-Move, MIT license. Node.js ${NODE_VERSION}: Copyright Node.js contributors, MIT license.` });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  return Buffer.from(pe.generate());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const bundle = path.join(OUT, 'Auto-Move.cjs');
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'exe-main.js')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: bundle, external: ['cpu-features', '*.node'], logLevel: 'warning' });

  const config = path.join(OUT, 'sea-config.json'), blob = path.join(OUT, 'sea-prep.blob');
  const assets = Object.fromEntries(['public/index.html', 'public/favicon.svg', 'lib/expr.js'].map(a => [a, path.join(__dirname, a)]));
  fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  let exe;
  if (TARGET === 'win') {
    const nodeExe = path.join(OUT, `node-${NODE_VERSION}-win-x64.exe`);
    if (!fs.existsSync(nodeExe)) { console.log(`Windows için Node.js ${NODE_VERSION} indiriliyor…`); await download(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`, nodeExe); }
    exe = path.join(OUT, 'Auto-Move.exe');
    fs.writeFileSync(exe, brand(unsign(fs.readFileSync(nodeExe))));
  } else {
    exe = path.join(OUT, 'Auto-Move');
    fs.copyFileSync(process.execPath, exe); fs.chmodSync(exe, 0o755);
  }
  const postject = require.resolve('postject/dist/cli.js');
  execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(TARGET === 'win' ? [] : ['--overwrite'])], { stdio: 'inherit' });
  for (const f of [bundle, config, blob]) fs.rmSync(f);
  console.log(`Hazır: ${exe}`);
})().catch(e => { console.error(e); process.exit(1); });
