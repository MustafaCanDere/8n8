'use strict';
/* Small, dependency-free HTML/XML helpers: a tolerant HTML parser with CSS-like selectors,
   an XML <-> JSON converter, an RSS/Atom reader and a basic Markdown <-> HTML converter. */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', laquo: '«', raquo: '»' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
  });
}
const encode = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m; while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/* ---------- HTML ---------- */
function parseHTML(html, { xml = false } = {}) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root; let i = 0; const s = String(html);
  const text = t => { if (t) cur.children.push({ text: xml ? t : decode(t), parent: cur }); };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { text(s.slice(i)); break; }
    text(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); cur.children.push({ text: s.slice(lt + 9, e < 0 ? s.length : e), parent: cur, cdata: true }); i = e < 0 ? s.length : e + 3; continue; }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') { const e = s.indexOf('>', lt); i = e < 0 ? s.length : e + 1; continue; }
    const m = /^<\/?([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(s.slice(lt));
    if (!m) { text('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const name = xml ? m[1] : m[1].toLowerCase();
    if (m[0][1] === '/') { // closing tag: pop to the matching element if it is open
      let n = cur; while (n && n.tag !== name) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const selfClose = /\/\s*$/.test(m[2]);
    const el = { tag: name, attrs: parseAttrs(m[2].replace(/\/\s*$/, '')), children: [], parent: cur };
    cur.children.push(el);
    if (selfClose || (!xml && VOID.has(name))) continue;
    if (!xml && RAW.has(name)) {
      const end = s.toLowerCase().indexOf(`</${name}`, i);
      const raw = s.slice(i, end < 0 ? s.length : end);
      if (raw) el.children.push({ text: name === 'title' || name === 'textarea' ? decode(raw) : raw, parent: el, raw: true });
      i = end < 0 ? s.length : s.indexOf('>', end) + 1;
      continue;
    }
    cur = el;
  }
  return root;
}
function textOf(n, { pretty = false } = {}) {
  if (n.text != null) return n.raw && n.parent && (n.parent.tag === 'script' || n.parent.tag === 'style') ? '' : n.text;
  if (n.tag === 'br') return '\n';
  const inner = n.children.map(c => textOf(c, { pretty })).join('');
  if (pretty && /^(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|ul|ol|table)$/.test(n.tag)) return `\n${inner}\n`;
  return inner;
}
const cleanText = t => t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function outerHTML(n) {
  if (n.text != null) return n.raw || n.cdata ? n.text : encode(n.text);
  if (n.tag === '#root') return n.children.map(outerHTML).join('');
  const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${encode(v)}"`).join('');
  if (VOID.has(n.tag)) return `<${n.tag}${a}>`;
  return `<${n.tag}${a}>${n.children.map(outerHTML).join('')}</${n.tag}>`;
}
const innerHTML = n => (n.children || []).map(outerHTML).join('');

/* selectors: tag, .class, #id, [attr], [attr=value], [attr*=value], :first-child, combined (a.b#c),
   descendant (space) and child (>) combinators, and comma-separated lists */
function parseSimple(sel) {
  const p = { tag: null, id: null, classes: [], attrs: [], first: false };
  const re = /^([A-Za-z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([*^$~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|:(first-child|last-child)/g;
  let m, pos = 0; re.lastIndex = 0;
  const src = sel;
  while (pos < src.length) {
    re.lastIndex = 0; m = re.exec(src.slice(pos));
    if (!m || m.index !== 0) throw new Error(`Seçici anlaşılamadı: "${sel}"`);
    if (m[1]) p.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) p.id = m[2];
    else if (m[3]) p.classes.push(m[3]);
    else if (m[4]) p.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] ?? m[7] ?? m[8] });
    else if (m[9]) p[m[9] === 'first-child' ? 'first' : 'last'] = true;
    pos += m[0].length;
  }
  return p;
}
function matchSimple(el, p) {
  if (!el.tag || el.tag === '#root') return false;
  if (p.tag && el.tag !== p.tag) return false;
  if (p.id && el.attrs.id !== p.id) return false;
  if (p.classes.length) { const cls = (el.attrs.class || '').split(/\s+/); if (!p.classes.every(c => cls.includes(c))) return false; }
  for (const a of p.attrs) {
    const v = el.attrs[a.name]; if (v == null) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
  }
  const sibs = el.parent ? el.parent.children.filter(c => c.tag) : [el];
  if (p.first && sibs[0] !== el) return false;
  if (p.last && sibs[sibs.length - 1] !== el) return false;
  return true;
}
function parseSelector(sel) {
  return String(sel).split(',').map(part => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const steps = []; let comb = ' ';
    for (const t of tokens) { if (t === '>') { comb = '>'; continue; } steps.push({ comb, p: parseSimple(t) }); comb = ' '; }
    if (!steps.length) throw new Error('Seçici boş');
    return steps;
  });
}
function matches(el, steps) {
  let k = steps.length - 1;
  if (!matchSimple(el, steps[k].p)) return false;
  let node = el;
  while (k > 0) {
    const { comb } = steps[k]; k--;
    if (comb === '>') { node = node.parent; if (!node || !matchSimple(node, steps[k].p)) return false; }
    else { node = node.parent; while (node && !matchSimple(node, steps[k].p)) node = node.parent; if (!node) return false; }
  }
  return true;
}
function selectAll(root, sel) {
  const groups = parseSelector(sel); const out = [];
  const walk = n => { for (const c of n.children || []) { if (c.tag && groups.some(g => matches(c, g))) out.push(c); if (c.children) walk(c); } };
  walk(root);
  return out;
}
function absUrl(v, base) { try { return base ? new URL(v, base).toString() : v; } catch { return v; } }

/* ---------- XML <-> JSON ---------- */
function xmlToJson(xml, { attrPrefix = '@' } = {}) {
  const root = parseHTML(xml, { xml: true });
  const conv = el => {
    const kids = el.children.filter(c => c.tag);
    const txt = el.children.filter(c => c.text != null).map(c => c.text).join('').trim();
    const attrs = Object.entries(el.attrs);
    if (!kids.length && !attrs.length) return txt === '' ? '' : decodeIfXml(txt);
    const o = {};
    for (const [k, v] of attrs) o[attrPrefix + k] = v;
    for (const k of kids) {
      const v = conv(k);
      if (k.tag in o) { if (!Array.isArray(o[k.tag]) || !o[k.tag].__multi) { o[k.tag] = Object.defineProperty([o[k.tag]], '__multi', { value: true }); } o[k.tag].push(v); }
      else o[k.tag] = v;
    }
    if (txt) o['#text'] = decodeIfXml(txt);
    return o;
  };
  const top = root.children.filter(c => c.tag);
  const o = {}; for (const t of top) o[t.tag] = conv(t);
  return JSON.parse(JSON.stringify(o));
}
function decodeIfXml(t) { return decode(t); }
function jsonToXml(obj, { rootName = 'kok', attrPrefix = '@', indent = '  ' } = {}) {
  const valid = k => /^[A-Za-z_][\w.-]*$/.test(k) ? k : 'oge';
  const node = (name, v, depth) => {
    const pad = indent.repeat(depth);
    if (Array.isArray(v)) return v.map(x => node(name, x, depth)).join('');
    if (v === null || typeof v !== 'object') return `${pad}<${valid(name)}>${encode(v ?? '')}</${valid(name)}>\n`;
    const attrs = Object.entries(v).filter(([k]) => k.startsWith(attrPrefix)).map(([k, x]) => ` ${valid(k.slice(attrPrefix.length))}="${encode(x)}"`).join('');
    const kids = Object.entries(v).filter(([k]) => !k.startsWith(attrPrefix) && k !== '#text');
    const text = v['#text'] != null ? encode(v['#text']) : '';
    if (!kids.length) return `${pad}<${valid(name)}${attrs}>${text}</${valid(name)}>\n`;
    return `${pad}<${valid(name)}${attrs}>${text}\n${kids.map(([k, x]) => node(k, x, depth + 1)).join('')}${pad}</${valid(name)}>\n`;
  };
  const keys = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [];
  const body = keys.length === 1 && !Array.isArray(obj[keys[0]]) ? node(keys[0], obj[keys[0]], 0) : node(rootName, obj, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/* ---------- RSS / Atom ---------- */
function parseFeed(xml, baseUrl) {
  const root = parseHTML(xml, { xml: true });
  const all = (n, name) => { const o = []; const w = x => { for (const c of x.children || []) { if (c.tag && c.tag.toLowerCase() === name) o.push(c); if (c.children) w(c); } }; w(n); return o; };
  const child = (n, ...names) => n.children.find(c => c.tag && names.includes(c.tag.toLowerCase()));
  const txt = n => n ? cleanText(decode(n.children.map(c => c.text != null ? c.text : textOf(c)).join(''))) : '';
  const rawTxt = n => n ? n.children.map(c => c.text != null ? c.text : outerHTML(c)).join('').trim() : '';
  const channel = all(root, 'channel')[0] || all(root, 'feed')[0] || root;
  const feed = { baslik: txt(child(channel, 'title')), link: '' };
  const items = (all(root, 'item').length ? all(root, 'item') : all(root, 'entry')).map(it => {
    const linkEl = child(it, 'link');
    const link = linkEl ? (linkEl.attrs.href || txt(linkEl)) : '';
    const content = rawTxt(child(it, 'content:encoded', 'content'));
    const summary = rawTxt(child(it, 'description', 'summary'));
    const date = txt(child(it, 'pubdate', 'published', 'updated', 'dc:date'));
    const d = date ? new Date(date) : null;
    return {
      baslik: txt(child(it, 'title')),
      link: absUrl(link, baseUrl),
      tarih: d && !isNaN(d) ? d.toISOString() : date,
      ozet: cleanText(textOf(parseHTML(summary || content))).slice(0, 2000),
      icerik: content || summary,
      yazar: txt(child(it, 'author', 'dc:creator')).replace(/\s+/g, ' '),
      kategoriler: it.children.filter(c => c.tag && c.tag.toLowerCase() === 'category').map(c => c.attrs.term || txt(c)),
      guid: txt(child(it, 'guid', 'id')) || link,
    };
  });
  return { feed, items };
}

/* ---------- Markdown ---------- */
function mdInline(s) {
  return encode(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${encode(buf.join('\n'))}</code></pre>`); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l); const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(`<li>${mdInline(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`);
      out.push(`<${ordered ? 'ol' : 'ul'}>${buf.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(h => `<th>${mdInline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(mdInline).join('<br>\n')}</p>`);
  }
  return out.join('\n');
}
function htmlToMarkdown(html) {
  const root = parseHTML(html);
  const md = (n, ctx = {}) => {
    if (n.text != null) return n.raw ? '' : n.text.replace(/\s+/g, ' ');
    const inner = () => n.children.map(c => md(c, ctx)).join('');
    switch (n.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `\n\n${'#'.repeat(+n.tag[1])} ${inner().trim()}\n\n`;
      case 'p': case 'div': case 'section': case 'article': return `\n\n${inner().trim()}\n\n`;
      case 'br': return '  \n';
      case 'strong': case 'b': return `**${inner()}**`;
      case 'em': case 'i': return `*${inner()}*`;
      case 'code': return ctx.pre ? inner() : `\`${inner()}\``;
      case 'pre': return `\n\n\`\`\`\n${textOf(n)}\n\`\`\`\n\n`;
      case 'a': return `[${inner().trim()}](${n.attrs.href || ''})`;
      case 'img': return `![${n.attrs.alt || ''}](${n.attrs.src || ''})`;
      case 'ul': case 'ol': return `\n\n${n.children.filter(c => c.tag === 'li').map((li, k) => `${n.tag === 'ol' ? `${k + 1}.` : '-'} ${li.children.map(c => md(c, ctx)).join('').trim()}`).join('\n')}\n\n`;
      case 'blockquote': return `\n\n${inner().trim().split('\n').map(x => `> ${x}`).join('\n')}\n\n`;
      case 'hr': return '\n\n---\n\n';
      case 'script': case 'style': case 'head': return '';
      default: return inner();
    }
  };
  return md(root).replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { parseHTML, selectAll, textOf, cleanText, outerHTML, innerHTML, absUrl, decode, encode, xmlToJson, jsonToXml, parseFeed, markdownToHtml, htmlToMarkdown };
