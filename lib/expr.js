/* Auto-Move expression engine.
   A small JavaScript-subset interpreter for {{ … }} templates, shared by the server and the editor.
   No eval: literals, $json paths, operators, ternaries, array/object literals, arrow functions (x => x.a) and method calls on values. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Expr = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const BLOCK = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
  const OPS = ['===', '!==', '==', '!=', '<=', '>=', '=>', '&&', '||', '??', '?.'];
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  function tokenize(src) {
    const t = []; let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        let j = i; while (j < src.length && (/[0-9.eE_]/.test(src[j]) || (/[+-]/.test(src[j]) && /[eE]/.test(src[j - 1]) && /[0-9]/.test(src[j + 1] || '')))) j++;
        t.push({ t: 'num', v: parseFloat(src.slice(i, j).replace(/_/g, '')) }); i = j; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1, s = '';
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\') { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; } else s += src[j];
          j++;
        }
        if (j >= src.length) throw new Error('Kapanmamış metin');
        t.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      if (/[A-Za-z_$À-ɏ]/.test(c)) {
        let j = i; while (j < src.length && /[A-Za-z0-9_$À-ɏ]/.test(src[j])) j++;
        t.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
      }
      let m = OPS.find(o => src.startsWith(o, i));
      if (m === '?.' && /[0-9]/.test(src[i + 2] || '')) m = null;
      if (m) { t.push({ t: 'op', v: m }); i += m.length; continue; }
      if ('()[]{}.,?:!+-*/%<>'.includes(c)) { t.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`Beklenmeyen karakter: ${c}`);
    }
    t.push({ t: 'eof' });
    return t;
  }

  const LEVELS = [['??', '||'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
  function parse(src) {
    const tk = tokenize(src); let p = 0;
    const is = v => tk[p].t === 'op' && tk[p].v === v;
    const expect = v => { if (!is(v)) throw new Error(`"${v}" bekleniyordu`); p++; };
    const list = end => { const out = []; if (!is(end)) { do { out.push(expr()); } while (is(',') && ++p); } expect(end); return out; };
    // arrow functions with an expression body: x => …, (a, b) => …, () => …
    function expr() {
      if (tk[p].t === 'id' && tk[p + 1].t === 'op' && tk[p + 1].v === '=>') { const params = [tk[p].v]; p += 2; return { k: 'fn', params, body: expr() }; }
      if (is('(')) {
        let q = p + 1; const params = [];
        while (tk[q].t === 'id' && (tk[q + 1].v === ',' || tk[q + 1].v === ')')) { params.push(tk[q].v); q += tk[q + 1].v === ',' ? 2 : 1; if (tk[q].v === ')') break; }
        if (tk[q].t === 'op' && tk[q].v === ')' && tk[q + 1].t === 'op' && tk[q + 1].v === '=>') { p = q + 2; return { k: 'fn', params, body: expr() }; }
      }
      return ternary();
    }
    function ternary() {
      const c = bin(0);
      if (is('?')) { p++; const a = expr(); expect(':'); const b = expr(); return { k: 'cond', c, a, b }; }
      return c;
    }
    function bin(l) {
      if (l >= LEVELS.length) return unary();
      let left = bin(l + 1);
      while (tk[p].t === 'op' && LEVELS[l].includes(tk[p].v)) { const op = tk[p++].v; left = { k: 'bin', op, left, right: bin(l + 1) }; }
      return left;
    }
    function unary() {
      if (is('!') || is('-') || is('+')) { const op = tk[p++].v; return { k: 'un', op, a: unary() }; }
      return postfix();
    }
    function postfix() {
      let e = primary();
      for (;;) {
        if (is('?.') && tk[p + 1].t === 'op' && (tk[p + 1].v === '[' || tk[p + 1].v === '(')) {
          p += 2;
          if (tk[p - 1].v === '[') { const pr = ternary(); expect(']'); e = { k: 'mem', o: e, p: pr, opt: true }; }
          else e = { k: 'call', f: e, args: list(')'), opt: true };
        } else if (is('.') || is('?.')) {
          const opt = tk[p++].v === '?.'; const id = tk[p++];
          if (id.t !== 'id') throw new Error('Alan adı bekleniyordu');
          e = { k: 'mem', o: e, p: { k: 'lit', v: id.v }, opt };
        } else if (is('[')) { p++; const pr = ternary(); expect(']'); e = { k: 'mem', o: e, p: pr }; }
        else if (is('(')) { p++; e = { k: 'call', f: e, args: list(')') }; }
        else return e;
      }
    }
    function primary() {
      const t = tk[p++];
      if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'id') {
        const lits = { true: true, false: false, null: null, undefined: undefined };
        return t.v in lits ? { k: 'lit', v: lits[t.v] } : { k: 'id', v: t.v };
      }
      if (t.t === 'op' && t.v === '(') { const e = expr(); expect(')'); return e; }
      if (t.t === 'op' && t.v === '[') return { k: 'arr', items: list(']') };
      if (t.t === 'op' && t.v === '{') {
        const props = [];
        if (!is('}')) do {
          const key = tk[p++]; if (key.t !== 'id' && key.t !== 'str') throw new Error('Nesne anahtarı bekleniyordu');
          expect(':'); props.push([key.v, expr()]);
        } while (is(',') && ++p);
        expect('}'); return { k: 'obj', props };
      }
      throw new Error(t.t === 'eof' ? 'İfade eksik' : `Beklenmeyen: ${t.v}`);
    }
    const ast = expr();
    if (tk[p].t !== 'eof') throw new Error(`Fazla ifade: ${tk[p].v ?? ''}`);
    return ast;
  }

  // Values an expression must never get hold of: anything that turns a string into code.
  const FORBIDDEN = new Set([Function, Object.getPrototypeOf(async () => {}).constructor, Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function* () {}).constructor]);
  const FN_PROTO = [Function.prototype.call, Function.prototype.apply, Function.prototype.bind];
  const guard = v => { if (typeof v === 'function' && FORBIDDEN.has(v)) throw new Error('İzin verilmiyor'); return v; };
  const SHORT = Symbol('short'); // a ?. met null/undefined: the rest of the chain is skipped
  const sub = (n, s) => n.k === 'mem' || n.k === 'call' ? chain(n, s) : ev(n, s);
  function chain(n, s) {
    if (n.k === 'mem') {
      const o = sub(n.o, s); if (o === SHORT) return SHORT;
      const k = ev(n.p, s);
      if (o == null) { if (n.opt) return SHORT; throw new Error(`"${k}" okunamıyor: değer boş`); }
      if (BLOCK.has(String(k))) throw new Error('İzin verilmeyen alan');
      return guard(o[k]);
    }
    let fn, self;
    if (n.f.k === 'mem') {
      self = sub(n.f.o, s); if (self === SHORT) return SHORT;
      const k = ev(n.f.p, s);
      if (self == null) { if (n.f.opt) return SHORT; throw new Error(`"${k}" çağrılamıyor: değer boş`); }
      if (BLOCK.has(String(k))) throw new Error('İzin verilmeyen alan');
      fn = self[k];
      if (fn == null && n.opt) return SHORT;
      if (typeof fn !== 'function') throw new Error(`${k} bir fonksiyon değil`);
    } else {
      fn = sub(n.f, s); if (fn === SHORT) return SHORT;
      if (fn == null && n.opt) return SHORT;
      if (typeof fn !== 'function') throw new Error('Fonksiyon değil');
    }
    guard(fn);
    if (FN_PROTO.includes(fn)) guard(self);
    return guard(fn.apply(self, n.args.map(a => ev(a, s))));
  }
  function ev(n, s) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'fn': return (...args) => { const inner = Object.create(s); n.params.forEach((k, i) => { inner[k] = args[i]; }); return ev(n.body, inner); };
      case 'id': if (!(n.v in s)) throw new Error(`Tanımsız: ${n.v}`); return guard(s[n.v]);
      case 'arr': return n.items.map(i => ev(i, s));
      case 'obj': { const o = {}; for (const [k, v] of n.props) { if (BLOCK.has(k)) throw new Error('İzin verilmeyen anahtar'); o[k] = ev(v, s); } return o; }
      case 'cond': return ev(n.c, s) ? ev(n.a, s) : ev(n.b, s);
      case 'un': { const a = ev(n.a, s); return n.op === '!' ? !a : n.op === '-' ? -a : +a; }
      case 'bin': {
        if (n.op === '&&') { const l = ev(n.left, s); return l ? ev(n.right, s) : l; }
        if (n.op === '||') { const l = ev(n.left, s); return l ? l : ev(n.right, s); }
        if (n.op === '??') { const l = ev(n.left, s); return l ?? ev(n.right, s); }
        const l = ev(n.left, s), r = ev(n.right, s);
        switch (n.op) {
          case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return l / r; case '%': return l % r;
          case '==': return l == r; case '!=': return l != r; case '===': return l === r; case '!==': return l !== r;
          case '<': return l < r; case '>': return l > r; case '<=': return l <= r; case '>=': return l >= r;
        }
        break;
      }
      case 'mem': case 'call': { const v = chain(n, s); return v === SHORT ? undefined : v; }
    }
    throw new Error('Bilinmeyen ifade');
  }

  const cache = new Map();
  const compile = src => { if (!cache.has(src)) { if (cache.size > 1000) cache.clear(); cache.set(src, parse(src)); } return cache.get(src); };
  function render(tpl, scope) {
    if (typeof tpl !== 'string' || !tpl.includes('{{')) return tpl;
    const m = tpl.match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);
    if (m && !m[1].includes('{{')) return ev(compile(m[1]), scope);
    return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
      const v = ev(compile(e), scope);
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }

  /* dates: YYYY MM DD HH mm ss tokens, local time */
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function toDate(v) {
    if (v instanceof Date) return v;
    if (v == null || v === '') return new Date();
    const d = new Date(typeof v === 'number' ? v : String(v));
    if (isNaN(d)) throw new Error(`Geçersiz tarih: ${v}`);
    return d;
  }
  function formatDate(v, pattern = 'YYYY-MM-DD HH:mm:ss') {
    const d = toDate(v);
    const map = { YYYY: d.getFullYear(), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
    return String(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, t => map[t]);
  }
  const UNITS = { saniye: 1000, dakika: 60000, saat: 3600000, gun: 86400000, hafta: 604800000, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  function addTime(v, amount, unit = 'gun') {
    const d = toDate(v);
    if (unit === 'ay' || unit === 'M') { const r = new Date(d); r.setMonth(r.getMonth() + Number(amount)); return r.toISOString(); }
    if (unit === 'yil' || unit === 'y') { const r = new Date(d); r.setFullYear(r.getFullYear() + Number(amount)); return r.toISOString(); }
    if (!UNITS[unit]) throw new Error(`Bilinmeyen birim: ${unit}`);
    return new Date(d.getTime() + Number(amount) * UNITS[unit]).toISOString();
  }
  const dt = Object.freeze({ format: formatDate, add: addTime, now: () => new Date().toISOString(), parse: v => toDate(v).toISOString(), diff: (a, b, unit = 'gun') => (toDate(b) - toDate(a)) / (UNITS[unit] || 1) });

  // Only data helpers are exposed; no Reflect, no property descriptors, no prototypes.
  const SafeObject = Object.freeze({ keys: o => Object.keys(o), values: o => Object.values(o), entries: o => Object.entries(o), fromEntries: e => Object.fromEntries(e), assign: (t, ...src) => Object.assign(t, ...src.map(x => x == null ? x : Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(x))).filter(([k]) => !BLOCK.has(k))))) });
  const SafeArray = Object.freeze({ isArray: v => Array.isArray(v), from: (v, f) => f ? Array.from(v, f) : Array.from(v), of: (...a) => a });
  const SafeNumber = Object.freeze(Object.assign(v => Number(v), { isInteger: Number.isInteger, isFinite: Number.isFinite, isNaN: Number.isNaN, parseFloat, parseInt, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER }));
  const SafeString = Object.freeze(Object.assign(v => String(v), { fromCharCode: String.fromCharCode }));
  const SafeJSON = Object.freeze({ parse: t => JSON.parse(t), stringify: (v, r, sp) => JSON.stringify(v, Array.isArray(r) ? r : null, sp) });
  const GLOBALS = { Math, JSON: SafeJSON, Number: SafeNumber, String: SafeString, Boolean: v => Boolean(v), Array: SafeArray, Object: SafeObject, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent };
  function makeScope({ item, index, items, nodeMap, vars, execution, workflow } = {}) {
    const s = Object.assign(Object.create(null), GLOBALS);
    s.$json = item?.json ?? {};
    s.$index = index ?? 0;
    s.$items = (items || []).map(i => i.json);
    s.$input = { all: s.$items, first: s.$items[0] ?? {}, last: s.$items[s.$items.length - 1] ?? {}, item: s.$json };
    s.$node = nodeMap || {};
    s.$vars = vars || {};
    s.$execution = execution || { id: 'önizleme', mode: 'manuel' };
    s.$workflow = workflow || {};
    s.$now = new Date().toISOString();
    s.$today = formatDate(new Date(), 'YYYY-MM-DD');
    s.$dt = dt;
    return s;
  }

  return { render, parse, makeScope, formatDate, addTime, isObj };
});
