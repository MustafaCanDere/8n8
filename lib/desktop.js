'use strict';
/* Desktop comforts: an icon next to the clock on Windows (open, start with Windows, check for updates, quit),
   starting with the computer (Windows registry, Linux autostart, macOS login item), running Auto-Move.exe
   without a console window, Windows notifications, and updating the exe from GitHub Releases. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { inSea } = require('./sea');
const { unzip } = require('./zip');
const pkg = require('../package.json');

const WIN = process.platform === 'win32';
const DATA = path.resolve(process.env.N8N8_DATA || path.join(os.homedir(), '.8n8'));
const PORT = Number(process.env.PORT || process.env.N8N8_PORT || 5678);
const BACKGROUND = process.argv.includes('--arka-plan'); // started by the computer: no browser window
const EXE = process.env.N8N8_UPDATE_TARGET || (inSea ? process.execPath : null); // the file an update replaces
const REPO = process.env.N8N8_UPDATE_REPO || 'MustafaCanDere/AutoHook';
const API = (process.env.N8N8_UPDATE_API || 'https://api.github.com').replace(/\/$/, '');
const SETTINGS = path.join(DATA, 'masaustu.json');
const bad = msg => Object.assign(new Error(msg), { status: 400 });

let settings = { guncellemeDenetle: true };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}

/* ---------- without a console window (Auto-Move.exe on Windows) ---------- */
/* Double-clicking the exe opens a console. Start a hidden copy that writes to auto-move.log instead, wait
   until it answers, then close the console. If it stops early, show why. */
function probe(port) {
  return new Promise(r => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, res => { res.resume(); r(true); });
    req.on('error', () => r(false)); req.on('timeout', () => { req.destroy(); r(false); });
  });
}
function openUrl(u) {
  const cmd = WIN ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
const LOG = path.join(DATA, 'auto-move.log');
function logFd() {
  fs.mkdirSync(DATA, { recursive: true });
  try { if (fs.statSync(LOG).size > 5 * 1048576) fs.renameSync(LOG, LOG + '.1'); } catch {}
  return fs.openSync(LOG, 'a');
}
function spawnHidden(args, env = {}) {
  const fd = logFd();
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env, N8N8_ARKA: '1' } });
  fs.closeSync(fd);
  return child;
}
async function detach() {
  const url = (process.env.N8N8_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  if (await probe(PORT)) { console.log(`\n  Auto-Move zaten açık: ${url}`); if (!BACKGROUND) openUrl(url); return setTimeout(() => process.exit(0), 1500); }
  console.log('\n  Auto-Move arka planda başlatılıyor…\n  Açınca bu pencere kapanır. Auto-Move\'u saatin yanındaki simgeden açıp kapatabilirsiniz.');
  const child = spawnHidden(process.argv.slice(2)); // in an exe argv[1] is the exe again
  let done = false;
  child.on('exit', code => {
    if (done) return; done = true;
    let tail = ''; try { tail = fs.readFileSync(LOG, 'utf8').split('\n').slice(-15).join('\n'); } catch {}
    console.error(`\n  Auto-Move başlarken durdu (çıkış kodu ${code}). Son kayıtlar:\n\n${tail}\n\n  Kayıt dosyası: ${LOG}\n  Pencereyi kapatmak için Enter'a basın.`);
    process.stdin.resume(); process.stdin.once('data', () => process.exit(1));
  });
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probe(PORT)) { done = true; child.unref(); return process.exit(0); }
  }
  if (!done) { done = true; child.unref(); process.exit(0); }
}

/* ---------- start with the computer ---------- */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const launchArgs = () => [process.execPath, ...(inSea ? [] : [path.join(__dirname, '..', 'server.js')]), '--arka-plan'];
const autostartFile = () => process.env.N8N8_AUTOSTART_DIR ? path.join(process.env.N8N8_AUTOSTART_DIR, 'auto-move.desktop')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.auto-move.plist')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'auto-move.desktop');
const useRegistry = () => WIN && !process.env.N8N8_AUTOSTART_DIR;
const run = (cmd, args) => new Promise(r => execFile(cmd, args, { windowsHide: true }, (e, out) => r(e ? null : String(out))));
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function getAutostart() {
  if (useRegistry()) return { supported: true, on: !!(await run('reg', ['query', RUN_KEY, '/v', 'Auto-Move'])) };
  return { supported: true, on: fs.existsSync(autostartFile()) };
}
async function setAutostart(on) {
  const env = Object.entries({ N8N8_DATA: process.env.N8N8_DATA, PORT: process.env.PORT, N8N8_PORT: process.env.N8N8_PORT, N8N8_HOST: process.env.N8N8_HOST, N8N8_URL: process.env.N8N8_URL }).filter(([, v]) => v);
  if (useRegistry()) {
    // the Run key holds a command line only; env settings other than the defaults need the start scripts instead
    const cmd = launchArgs().map(a => /\s|"/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
    const r = on ? await run('reg', ['add', RUN_KEY, '/v', 'Auto-Move', '/t', 'REG_SZ', '/d', cmd, '/f']) : await run('reg', ['delete', RUN_KEY, '/v', 'Auto-Move', '/f']);
    if (r === null && on) throw bad('Windows başlangıcına eklenemedi');
    return getAutostart();
  }
  const f = autostartFile();
  if (!on) { try { fs.unlinkSync(f); } catch {} return getAutostart(); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (f.endsWith('.plist')) {
    fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
  <key>Label</key><string>com.auto-move</string>
  <key>ProgramArguments</key><array>${launchArgs().map(a => `<string>${xmlEsc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${env.map(([k, v]) => `<key>${k}</key><string>${xmlEsc(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEsc(LOG)}</string><key>StandardErrorPath</key><string>${xmlEsc(LOG)}</string>
</dict></plist>\n`);
  } else {
    const q = a => `"${String(a).replace(/["`$\\]/g, c => '\\' + c)}"`;
    fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=Auto-Move\nComment=İş akışı otomasyonu\nExec=${env.length ? `env ${env.map(([k, v]) => `${k}=${q(v)}`).join(' ')} ` : ''}${launchArgs().map(q).join(' ')}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  }
  return getAutostart();
}

/* ---------- updates from GitHub Releases ---------- */
const parseV = v => String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = parseV(a), y = parseV(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
let last = null; // result of the last check
const assetName = /windows\.zip$/i;

async function checkUpdate() {
  const res = await fetch(`${API}/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Auto-Move' }, signal: AbortSignal.timeout(20000) })
    .catch(e => { throw bad(`Güncelleme sunucusuna ulaşılamadı: ${e.cause?.message || e.message}`); });
  if (res.status === 404) return (last = { current: pkg.version, latest: null, newer: false, checked: new Date().toISOString() });
  if (!res.ok) throw bad(`Güncelleme denetlenemedi (GitHub ${res.status})`);
  const r = await res.json();
  const asset = (r.assets || []).find(a => assetName.test(a.name));
  last = {
    current: pkg.version, latest: String(r.tag_name || '').replace(/^v/i, ''), newer: newer(r.tag_name, pkg.version),
    notes: String(r.body || '').slice(0, 2000), page: r.html_url || `https://github.com/${REPO}/releases/latest`,
    download: asset?.browser_download_url || null, canInstall: !!(EXE && asset), checked: new Date().toISOString(),
  };
  return last;
}

/* Downloads the release zip, swaps the exe file (Windows lets a running exe be renamed, not overwritten)
   and leaves the old one as .old, which the next start deletes. The caller restarts the program. */
async function installUpdate() {
  const u = last?.newer ? last : await checkUpdate();
  if (!u.newer) throw bad('Zaten en yeni sürümü kullanıyorsunuz');
  if (!EXE) throw bad('Kendiliğinden güncelleme yalnızca Auto-Move.exe ile çalışır. Kaynak koddan çalıştırıyorsanız yeni sürümü GitHub\'dan indirin.');
  if (!u.download) throw bad('Bu sürümde Windows paketi yok');
  if (!process.env.N8N8_UPDATE_API && !/^https:\/\/github\.com\//.test(u.download)) throw bad('Güncelleme adresi GitHub dışında');
  const res = await fetch(u.download, { headers: { 'User-Agent': 'Auto-Move' }, signal: AbortSignal.timeout(10 * 60000) })
    .catch(e => { throw bad(`Güncelleme indirilemedi: ${e.cause?.message || e.message}`); });
  if (!res.ok) throw bad(`Güncelleme indirilemedi (${res.status})`);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  const name = Object.keys(files).find(n => /(^|[\\/])Auto-Move\.exe$/i.test(n));
  if (!name) throw bad('Güncelleme paketinde Auto-Move.exe yok');
  const bin = files[name]();
  if (WIN && bin.subarray(0, 2).toString() !== 'MZ') throw bad('Güncelleme paketindeki dosya bir Windows programı değil');
  const tmp = EXE + '.new', old = EXE + '.old';
  fs.writeFileSync(tmp, bin, { mode: 0o755 });
  try { fs.unlinkSync(old); } catch {}
  fs.renameSync(EXE, old);
  try { fs.renameSync(tmp, EXE); } catch (e) { fs.renameSync(old, EXE); throw bad(`Yeni sürüm yerine konamadı: ${e.message}`); }
  return { ok: true, version: u.latest };
}
function cleanupOld() { if (EXE) try { fs.unlinkSync(EXE + '.old'); } catch {} }

/* starts the (new) exe again with the same arguments, hidden, once this one has let go of the port */
function relaunch() {
  if (!inSea || process.env.N8N8_NO_RESTART) return false;
  spawnHidden(process.argv.slice(2), { N8N8_YENIDEN: '1' }).unref();
  return true;
}

/* ---------- notification-area icon (Windows) ---------- */
const TRAY_PS1 = `param([string]$Exe, [string]$Msg, [int]$ParentPid, [int]$Oto)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe) } catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'Auto-Move'
function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Quit { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Auto-Move''u aç')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Say 'ac' })
$oto = New-Object System.Windows.Forms.ToolStripMenuItem('Windows açılınca başlat')
$oto.Checked = [bool]$Oto
$oto.add_Click({ $oto.Checked = -not $oto.Checked; Say ('oto:' + [int]$oto.Checked) })
[void]$menu.Items.Add($oto)
$upd = $menu.Items.Add('Güncellemeleri denetle')
$upd.add_Click({ Say 'guncelle' })
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Kapat')
$quit.add_Click({ Say 'kapat'; Quit })
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Say 'ac' } })
$ni.add_BalloonTipClicked({ Say 'balon' })
$ni.Visible = $true
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 1000
$t.add_Tick({
  try { [void][System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { Quit; return }
  if (Test-Path -LiteralPath $Msg) {
    try { $lines = @(Get-Content -LiteralPath $Msg -Encoding UTF8); Remove-Item -LiteralPath $Msg } catch { return }
    foreach ($l in $lines) { $p = $l.Split([char]9, 2); if ($p.Count -eq 2) { $ni.ShowBalloonTip(8000, $p[0], $p[1], [System.Windows.Forms.ToolTipIcon]::Info) } }
  }
})
$t.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
`;
let tray = null, trayMsg = null, balloonLink = null;
const trayWanted = () => WIN && process.env.N8N8_TRAY !== '0' && (inSea || process.env.N8N8_TRAY === '1');

async function startTray({ url, onQuit, onUpdate }) {
  if (!trayWanted()) return false;
  const dir = path.join(os.tmpdir(), 'auto-move');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'tepsi.ps1');
  fs.writeFileSync(script, '﻿' + TRAY_PS1); // with a BOM, Windows PowerShell reads the Turkish letters as UTF-8
  trayMsg = path.join(dir, `mesaj-${process.pid}.txt`);
  const oto = (await getAutostart()).on ? 1 : 0;
  tray = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
    '-Exe', process.execPath, '-Msg', trayMsg, '-ParentPid', String(process.pid), '-Oto', String(oto)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  tray.on('error', e => { console.error('Bildirim alanı simgesi açılamadı:', e.message); tray = null; });
  tray.on('exit', () => { tray = null; });
  let buf = '';
  tray.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (cmd === 'ac') openUrl(url);
      else if (cmd === 'balon') openUrl(balloonLink || url);
      else if (cmd.startsWith('oto:')) setAutostart(cmd === 'oto:1').catch(e => notifyDesktop('Auto-Move', e.message));
      else if (cmd === 'guncelle') onUpdate();
      else if (cmd === 'kapat') onQuit();
    }
  });
  process.on('exit', stopTray);
  return true;
}
function stopTray() { try { tray?.kill(); } catch {} try { if (trayMsg) fs.unlinkSync(trayMsg); } catch {} }

/* a Windows notification from the tray icon; clicking it opens `link` */
function notifyDesktop(title, text, link) {
  if (!tray || !trayMsg) return false;
  balloonLink = link || null;
  const clean = s => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
  try { fs.appendFileSync(trayMsg, `${clean(title).slice(0, 63) || 'Auto-Move'}\t${clean(text).slice(0, 250) || ' '}\n`); return true; } catch { return false; }
}

/* failed automatic runs pop up next to the clock, at most once a minute per workflow */
const lastPop = new Map();
function onEnd(wf, exec, publicUrl) {
  if (!tray || exec.status !== 'error' || exec.mode === 'manuel' || /testi$/.test(exec.mode)) return;
  if (Date.now() - (lastPop.get(wf.id) || 0) < 60000) return;
  lastPop.set(wf.id, Date.now());
  notifyDesktop(`"${wf.name}" hata verdi`, String(exec.error || ''), `${publicUrl}/#/calistirma/${exec.id}`);
}

/* checks once a day while the program is open and says so next to the clock when a new version is out */
function scheduleChecks(publicUrl) {
  if (process.env.N8N8_NO_UPDATE_CHECK) return;
  const tick = async () => {
    if (!settings.guncellemeDenetle) return;
    try {
      const u = await checkUpdate();
      if (u.newer && settings.bildirilen !== u.latest) {
        if (notifyDesktop(`Auto-Move ${u.latest} çıktı`, 'Güncellemek için tıklayın, Ayarlar sayfası açılır.', `${publicUrl}/#/hakkinda`)) saveSettings({ bildirilen: u.latest });
      }
    } catch {}
  };
  setTimeout(tick, 15000).unref();
  setInterval(tick, 24 * 3600000).unref();
}
function saveSettings(s) {
  settings = { ...settings, ...s };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {}
  return settings;
}

async function info() {
  return { tray: !!tray, exe: !!EXE, platform: process.platform, autostart: await getAutostart(), guncellemeDenetle: settings.guncellemeDenetle !== false, update: last, log: process.env.N8N8_ARKA ? LOG : null };
}

module.exports = { TRAY_PS1, BACKGROUND, detach, openUrl, getAutostart, setAutostart, checkUpdate, installUpdate, cleanupOld, relaunch, startTray, stopTray, notifyDesktop, onEnd, scheduleChecks, saveSettings, info, newer };
