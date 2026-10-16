'use strict';
/* Cron expressions: "dk saat gün ay haftagünü" (5 fields) or with leading seconds (6 fields).
   Supports *, lists (1,2), ranges (1-5), steps (*\/15, 1-30/5) and day/month names. */
const NAMES = {
  mon: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};
const RANGES = { sec: [0, 59], min: [0, 59], hour: [0, 23], dom: [1, 31], mon: [1, 12], dow: [0, 7] };

function parseField(src, kind) {
  const [lo, hi] = RANGES[kind];
  const set = new Set();
  const num = s => {
    const k = s.toLowerCase();
    if (NAMES[kind] && k in NAMES[kind]) return NAMES[kind][k];
    const n = Number(s);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Cron: "${s}" ${kind} alanı için geçersiz`);
    return n;
  };
  for (const part of src.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron: geçersiz adım "${stepS}"`);
    let a, b;
    if (range === '*') { a = lo; b = hi; }
    else if (range.includes('-')) { const [x, y] = range.split('-'); a = num(x); b = num(y); }
    else { a = num(range); b = stepS ? hi : a; }
    if (a > b) throw new Error(`Cron: aralık ters "${range}"`);
    for (let v = a; v <= b; v += step) set.add(kind === 'dow' && v === 7 ? 0 : v);
  }
  return set;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) throw new Error('Cron ifadesi 5 alan olmalı: dakika saat gün ay haftagünü');
  if (parts.length === 5) parts.unshift('0');
  const [sec, min, hour, dom, mon, dow] = parts;
  return {
    sec: parseField(sec, 'sec'), min: parseField(min, 'min'), hour: parseField(hour, 'hour'),
    dom: parseField(dom, 'dom'), mon: parseField(mon, 'mon'), dow: parseField(dow, 'dow'),
    domStar: dom === '*', dowStar: dow === '*',
  };
}

function matchesDay(c, d) {
  const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // classic cron: either matches
}

/** Next matching time strictly after `from` (local time). */
function nextRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime() + 1000); d.setMilliseconds(0);
  const limit = from.getTime() + 366 * 86400000 * 2;
  while (d.getTime() < limit) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0); continue; }
    if (!matchesDay(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0); continue; }
    if (!c.sec.has(d.getSeconds())) { d.setSeconds(d.getSeconds() + 1); continue; }
    return d;
  }
  throw new Error('Cron ifadesi önümüzdeki iki yılda hiç eşleşmiyor');
}

module.exports = { parseCron, nextRun };
