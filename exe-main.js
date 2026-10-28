'use strict';
/* Entry point of Auto-Move.exe. The same exe also serves as the Kod node's sandboxed child process. */
if (process.env.N8N8_CODE_CHILD === '1') { for (const k of Object.keys(process.env)) delete process.env[k]; require('./lib/code-child'); } // the user's code sees an empty environment
else {
  process.on('uncaughtException', e => {
    console.error('\n  Auto-Move bir hatayla durdu:\n  ' + (e && e.stack || e) + '\n\n  Pencereyi kapatmak için Enter\'a basın.');
    process.stdin.resume(); process.stdin.once('data', () => process.exit(1));
  });
  require('./server');
}
