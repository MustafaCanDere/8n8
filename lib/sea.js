'use strict';
/* Lets Auto-Move run as one Windows .exe (a Node.js single executable application): the editor files
   are embedded in the exe as assets instead of being read from the program folder. */
const fs = require('fs');
const path = require('path');

let sea = null;
try { sea = require('node:sea'); } catch {}
const inSea = !!(sea && sea.isSea && sea.isSea());
const ROOT = path.join(__dirname, '..');

const readAsset = rel => inSea ? Buffer.from(sea.getAsset(rel)) : fs.readFileSync(path.join(ROOT, rel));

module.exports = { inSea, readAsset };
