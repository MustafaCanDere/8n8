'use strict';
/* Excel (.xlsx) read and write without packages. Reading keeps numbers, booleans, text and dates
   (cells with a date format become "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss"); formulas give their saved value.
   Writing makes a plain workbook with one sheet, a bold header row and a frozen first row. */
const M = require('./markup');
const { unzip, zip } = require('./zip');

const bad = msg => Object.assign(new Error(msg), { status: 400 });
const dec = s => M.decode(String(s ?? ''));
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? dec(m[1]) : undefined; };
const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function textOf(xml) { // concatenated <t> runs (rich text keeps several)
  let s = ''; for (const m of String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += dec(m[1]);
  return s;
}
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function dateStyles(z) {
  const xml = z['xl/styles.xml']?.().toString('utf8'); if (!xml) return [];
  const custom = {};
  for (const m of xml.matchAll(/<numFmt\s[^>]*>/g)) custom[attr(m[0], 'numFmtId')] = attr(m[0], 'formatCode') || '';
  const xfs = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  return [...xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].map(m => {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    if (DATE_IDS.has(id)) return id >= 18 && id <= 21 ? 'time' : id === 22 ? 'datetime' : 'date';
    const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/[dy]/i.test(code) || (/m/i.test(code) && /[dy]/i.test(code))) return /[hs]/i.test(code) ? 'datetime' : 'date';
    if (/h/i.test(code) && /s|mm/i.test(code)) return 'time';
    return null;
  });
}
function excelDate(v, kind, date1904) {
  const ms = Math.round((v + (date1904 ? 1462 : 0) - 25569) * 864e5);
  const iso = new Date(ms).toISOString();
  return kind === 'date' ? iso.slice(0, 10) : kind === 'time' ? iso.slice(11, 19) : iso.slice(0, 19);
}

/* -> [{ name, rows: [[cell, ...], ...] }] */
function readWorkbook(buf) {
  const z = unzip(buf);
  if (!z['xl/workbook.xml']) throw bad('Excel dosyası okunamadı (.xlsx bekleniyordu; eski .xls dosyalarını Excel\'de .xlsx olarak kaydedin)');
  const wb = z['xl/workbook.xml']().toString('utf8');
  const date1904 = /date1904="(1|true)"/.test(wb);
  const rels = {};
  for (const m of (z['xl/_rels/workbook.xml.rels']?.().toString('utf8') || '').matchAll(/<Relationship\s[^>]*>/g)) rels[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const shared = [];
  const ss = z['xl/sharedStrings.xml']?.().toString('utf8') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const styles = dateStyles(z);
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name'); const rid = attr(m[0], 'r:id');
    let target = rels[rid] || ''; target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const f = z[target]; if (!f) continue;
    const xml = f().toString('utf8');
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      if (!r[2]) continue;
      const rn = Number(attr(r[0], 'r')) - 1; const row = [];
      let auto = 0;
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[0], 'r'); const ci = ref ? colIndex(ref) : auto; auto = ci + 1;
        const t = attr(c[0], 't'); const s = Number(attr(c[0], 's') || 0); const inner = c[2] || '';
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = null;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = v == null ? '' : dec(v);
        else if (t === 'b') val = v === '1';
        else if (v != null && v !== '') { const n = Number(v); val = styles[s] && Number.isFinite(n) ? excelDate(n, styles[s], date1904) : n; }
        row[ci] = val;
      }
      rows[Number.isFinite(rn) && rn >= 0 ? rn : rows.length] = row;
    }
    sheets.push({ name, rows: Array.from(rows, r => Array.from(r || [], x => x ?? null)) });
  }
  if (!sheets.length) throw bad('Excel dosyasında sayfa bulunamadı');
  return sheets;
}

/* rows -> items using the first non-empty row as headers */
function toItems(rows, { header = true } = {}) {
  const list = rows.filter(r => r && r.some(v => v !== null && v !== ''));
  if (!list.length) return [];
  if (!header) return list.map(r => Object.fromEntries(r.map((v, i) => [colName(i), v])));
  const width = Math.max(...list.map(r => r.length));
  const heads = Array.from({ length: width }, (_, i) => { const h = list[0][i]; return h === null || h === '' ? colName(i) : String(h).trim(); });
  const seen = {}; const keys = heads.map(h => (seen[h] = (seen[h] || 0) + 1) > 1 ? `${h}_${seen[h]}` : h);
  return list.slice(1).map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
}
function pickSheet(sheets, name) {
  if (!name) return sheets[0];
  const s = sheets.find(x => x.name === name) || sheets.find(x => x.name.toLocaleLowerCase('tr') === String(name).toLocaleLowerCase('tr')) || (/^\d+$/.test(name) ? sheets[Number(name) - 1] : null);
  if (!s) throw bad(`"${name}" adlı sayfa yok. Sayfalar: ${sheets.map(x => x.name).join(', ')}`);
  return s;
}
function toText(buf) { // for the knowledge base: every sheet as tab-separated lines
  return readWorkbook(buf).map(s => `${s.name}\n${s.rows.filter(r => r.some(v => v !== null && v !== '')).map(r => r.map(v => v ?? '').join('\t')).join('\n')}`).join('\n\n');
}

/* items -> .xlsx Buffer */
const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function write(items, { sheet = 'Sayfa1' } = {}) {
  const keys = []; for (const it of items) for (const k of Object.keys(it || {})) if (!keys.includes(k)) keys.push(k);
  const cell = (v, ref, style = 0) => {
    const s = style ? ` s="${style}"` : '';
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xesc(str.slice(0, 32767))}</t></is></c>`;
  };
  const rows = [`<row r="1">${keys.map((k, i) => cell(k, `${colName(i)}1`, 1)).join('')}</row>`,
    ...items.map((it, r) => `<row r="${r + 2}">${keys.map((k, i) => cell(it?.[k], `${colName(i)}${r + 2}`)).join('')}</row>`)];
  const widths = keys.map(k => Math.min(60, Math.max(8, String(k).length + 2, ...items.slice(0, 200).map(it => String(it?.[k] ?? '').length + 1))));
  const name = xesc(String(sheet || 'Sayfa1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sayfa1');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${keys.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''}<sheetData>${rows.join('')}</sheetData></worksheet>`,
  });
}

module.exports = { readWorkbook, toItems, pickSheet, toText, write, colName };
