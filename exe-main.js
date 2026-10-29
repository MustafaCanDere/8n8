'use strict';
/* Entry point of Auto-Move.exe. The same exe also serves as the Kod node's sandboxed child process. */
if (process.env.N8N8_CODE_CHILD === '1') { for (const k of Object.keys(process.env)) delete process.env[k]; require('./lib/code-child'); } // the user's code sees an empty environment
// double-clicked on Windows: run without a console window, next to the clock (N8N8_CONSOLE=1 keeps the window)
else if (process.platform === 'win32' && process.stdout.isTTY && !process.env.N8N8_ARKA && !process.env.N8N8_CONSOLE) require('./lib/desktop').detach();
else {
  process.on('uncaughtException', e => {
    console.error('\n  Auto-Move bir hatayla durdu:\n  ' + (e && e.stack || e) + (process.env.N8N8_ARKA ? '' : '\n\n  Pencereyi kapatmak için Enter\'a basın.'));
    if (process.env.N8N8_ARKA) return process.exit(1);
    process.stdin.resume(); process.stdin.once('data', () => process.exit(1));
  });
  require('./server');
}
