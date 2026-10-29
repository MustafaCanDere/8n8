'use strict';
/* Execution engine: runs a workflow graph from one trigger in topological order. */
const { EventEmitter } = require('events');
const Expr = require('./expr');
const store = require('./store');
const { NODES, outputsOf, defaults } = require('./nodes');

const events = new EventEmitter();
events.setMaxListeners(100);
const running = new Map(); // execId -> { exec, controller }
/* "Onay bekle": an execution waiting for a person. token -> { execId, node, message, resolve }.
   Waiting lives in memory, so closing the program cancels it. */
const approvals = new Map();
let publicUrl = 'http://127.0.0.1:5678';
const setPublicUrl = u => { publicUrl = u; };
const approvalUrl = token => `${publicUrl}/onay/${token}`;
function decide(token, karar, not = '') {
  const a = approvals.get(token); if (!a || !a.resolve) return false;
  a.resolve({ karar, not: String(not || '').slice(0, 2000), zaman: new Date().toISOString() }); return true;
}
const MAX_STORED_ITEMS = 2000;
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const now = () => performance.now();

function trimForStorage(sets) {
  if (!sets) return sets;
  return sets.map(s => s.length > MAX_STORED_ITEMS ? [...s.slice(0, MAX_STORED_ITEMS), { json: { _kesildi: `${s.length - MAX_STORED_ITEMS} öğe daha var, kayda alınmadı` } }] : s);
}
function nodeMapFrom(outputs, nodes) {
  const m = {};
  for (const [id, out] of Object.entries(outputs)) {
    const n = nodes.find(x => x.id === id); if (!n || !out) continue;
    const all = out.flat();
    m[n.name] = { json: all[0]?.json ?? {}, items: all.map(i => i.json) };
  }
  return m;
}
function pickTrigger(wf, preferred) {
  const trig = wf.nodes.filter(n => NODES[n.type]?.trigger && !n.disabled);
  return trig.find(n => n.type === preferred) || trig.find(n => n.type === 'manual') || trig[0];
}

/**
 * Start a run. Returns { exec, done } where done resolves to the finished execution.
 * opts: triggerId, triggerData, mode, destinationId, usePinData, retryOf, depth, respond(res) -> bool
 */
/* "Aynı anda en fazla N çalıştırma": automatic runs of a workflow wait in line for a free slot.
   Editor runs (manual, node and *-test runs) never wait. */
const slots = new Map(); // workflowId -> { active, queue: [resolve] }
function acquireSlot(wfId, limit, signal) {
  const s = slots.get(wfId) || { active: 0, queue: [] }; slots.set(wfId, s);
  if (s.active < limit) { s.active++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const go = () => { signal.removeEventListener('abort', onAbort); s.active++; resolve(); };
    const onAbort = () => { s.queue = s.queue.filter(x => x !== go); reject(signal.reason || new Error('Çalıştırma durduruldu')); };
    signal.addEventListener('abort', onAbort, { once: true });
    s.queue.push(go);
  });
}
function releaseSlot(wfId) {
  const s = slots.get(wfId); if (!s) return;
  s.active = Math.max(0, s.active - 1);
  const next = s.queue.shift(); if (next) next();
  else if (!s.active) slots.delete(wfId);
}
const queuedCount = wfId => slots.get(wfId)?.queue.length || 0;

function start(wf, opts = {}) {
  const nodes = clone(wf.nodes), edges = clone(wf.edges);
  const nodeById = id => nodes.find(n => n.id === id);
  const trig = opts.triggerId ? nodeById(opts.triggerId) : pickTrigger(wf);
  if (!trig || !NODES[trig.type]?.trigger) throw Object.assign(new Error('Akışta çalıştırılabilecek bir tetikleyici yok'), { status: 400 });

  const exec = {
    id: store.uid(), workflowId: wf.id, workflowName: wf.name, mode: opts.mode || 'manuel', status: 'running',
    trigger: trig.name, triggerId: trig.id, triggerData: opts.triggerData ?? null, startedAt: new Date().toISOString(),
    retryOf: opts.retryOf || null, destinationId: opts.destinationId || null,
    snapshot: { nodes, edges, settings: wf.settings }, nodes: {}, order: [], edges: {}, error: null,
  };
  const resumeToken = require('crypto').randomBytes(18).toString('base64url');
  const controller = new AbortController();
  running.set(exec.id, { exec, controller });
  const emit = (type, extra) => events.emit('event', { type, execId: exec.id, workflowId: wf.id, ...extra });

  const done = (async () => {
    let t0 = now();
    const timeoutS = Number(wf.settings?.timeout) || 0;
    // the workflow timeout does not count time spent waiting for an approval
    let timer = null, timeLeft = timeoutS * 1000, armedAt = 0;
    const armTimeout = () => { if (timeoutS > 0) { armedAt = Date.now(); timer = setTimeout(() => controller.abort(new Error(`Akış ${timeoutS} sn zaman aşımını geçti`)), Math.max(0, timeLeft)); } };
    const pauseTimeout = () => { if (timer) { clearTimeout(timer); timer = null; timeLeft -= Date.now() - armedAt; } };
    armTimeout();
    store.saveExecution(exec);
    emit('exec:start', { mode: exec.mode, trigger: exec.trigger, startedAt: exec.startedAt });
    const outputs = {};
    let lastNodeId = null;
    let lastRanId = null;
    const limit = Math.max(0, Math.floor(Number(wf.settings?.maxConcurrent) || 0));
    let holding = false;
    try {
      if (limit > 0 && !/^(manuel|node testi)$|testi$/.test(exec.mode)) {
        const s = slots.get(wf.id);
        if (s && s.active >= limit) { pauseTimeout(); exec.queued = true; emit('exec:queued', { ahead: s.queue.length }); }
        await acquireSlot(wf.id, limit, controller.signal); holding = true;
        if (exec.queued) { t0 = now(); exec.startedAt = new Date().toISOString(); armTimeout(); }
      }
      // reachable from trigger, optionally restricted to ancestors of a destination node
      const reach = new Set([trig.id]); const stack = [trig.id];
      while (stack.length) { const id = stack.pop(); for (const e of edges) if (e.from === id && !reach.has(e.to) && nodeById(e.to)) { reach.add(e.to); stack.push(e.to); } }
      if (opts.destinationId) {
        const anc = new Set([opts.destinationId]); const st = [opts.destinationId];
        while (st.length) { const id = st.pop(); for (const e of edges) if (e.to === id && !anc.has(e.from)) { anc.add(e.from); st.push(e.from); } }
        for (const id of [...reach]) if (!anc.has(id)) reach.delete(id);
        if (!reach.has(opts.destinationId)) throw new Error('Seçilen node bu tetikleyiciden ulaşılamıyor');
      }
      const inner = edges.filter(e => reach.has(e.from) && reach.has(e.to));

      // loops: the body of a "loop" node is everything reachable from its "döngü" output without passing through it.
      // Edges from the body back into the loop node are the only allowed cycles.
      const bodyOf = new Map();
      for (const id of reach) {
        const n = nodeById(id);
        if (n.type !== 'loop') continue; // a disabled loop keeps its body (skipped) so the back edge is not a cycle
        const body = new Set(); const st = inner.filter(e => e.from === id && e.fromPort === 1).map(e => e.to);
        while (st.length) { const x = st.pop(); if (x === id || body.has(x)) continue; body.add(x); for (const e of inner) if (e.from === x) st.push(e.to); }
        bodyOf.set(id, body);
      }
      const isBack = e => bodyOf.get(e.to)?.has(e.from);
      const topo = set => {
        const es = inner.filter(e => set.has(e.from) && set.has(e.to) && !isBack(e));
        const indeg = new Map([...set].map(id => [id, 0]));
        es.forEach(e => indeg.set(e.to, indeg.get(e.to) + 1));
        const order = []; const q = [...set].filter(id => indeg.get(id) === 0);
        while (q.length) { const id = q.shift(); order.push(id); for (const e of es) if (e.from === id) { indeg.set(e.to, indeg.get(e.to) - 1); if (indeg.get(e.to) === 0) q.push(e.to); } }
        if (order.length < set.size) throw new Error('Akışta döngü var. Geri dönen bağlantılar yalnızca "Döngü" node\'una bağlanabilir.');
        return order;
      };
      // a set minus the bodies of the loops it contains (those run inside their loop node)
      const ownSet = (set, self) => { const s = new Set(set); for (const [l, b] of bodyOf) if (l !== self && set.has(l)) for (const x of b) if (x !== l) s.delete(x); return s; };

      const vars = store.getVariables();
      let iterating = 0; // >0 while inside a loop body: node records accumulate across iterations
      const staticData = () => store.getStatic(wf.id);

      async function runSet(set, self) { for (const id of topo(ownSet(set, self))) await runNode(id); }

      async function runNode(id) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu');
        const n = nodeById(id); const def = NODES[n.type];
        if (!def || def.note) return;
        let inputs = [];
        if (id !== trig.id) {
          inputs = Array.from({ length: def.inputs }, () => []);
          let any = false;
          for (const e of inner) {
            if (e.to !== id || isBack(e) || !outputs[e.from]) continue;
            const items = outputs[e.from][e.fromPort] || [];
            if (inputs[e.toPort]) inputs[e.toPort].push(...clone(items));
            if (items.length) any = true;
          }
          if (!any) {
            outputs[id] = undefined;
            if (!exec.nodes[id]) { exec.nodes[id] = { status: 'skipped', name: n.name, type: n.type, t: now() - t0, d: 0 }; exec.order.push(id); }
            emit('node:end', { nodeId: id, status: exec.nodes[id].status }); return;
          }
        }
        const prev = iterating && exec.nodes[id]?.status !== 'skipped' ? exec.nodes[id] : null;
        const rec = { status: 'running', name: n.name, type: n.type, input: inputs, output: null, t: now() - t0, d: 0, logs: prev?.logs || [], tries: 0 };
        if (!exec.nodes[id]) exec.order.push(id);
        exec.nodes[id] = rec; lastRanId = id;
        emit('node:start', { nodeId: id });
        const s = n.settings || {};
        try {
          if (n.disabled) { outputs[id] = [inputs[0] || []]; rec.status = 'disabled'; }
          else if (opts.usePinData && Array.isArray(n.pinData)) { outputs[id] = [n.pinData.map(json => ({ json: clone(json) }))]; rec.status = 'success'; rec.pinned = true; }
          else if (n.type === 'loop') { outputs[id] = await runLoop(n, inputs[0] || [], rec); rec.status = 'success'; }
          else {
            const maxTries = s.retryOnFail ? Math.max(1, Math.min(10, Number(s.maxTries) || 3)) : 1;
            for (let attempt = 1; ; attempt++) {
              rec.tries = attempt;
              try {
                const res = await def.run(makeCtx(n, id, inputs, rec));
                if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu');
                outputs[id] = (res || []).map(o => Array.isArray(o) ? o : []);
                rec.status = 'success';
                break;
              } catch (err) {
                if (controller.signal.aborted || attempt >= maxTries) throw err;
                rec.logs.push(`Deneme ${attempt} başarısız: ${err.message}. ${Number(s.retryWait) || 1000} ms sonra tekrar denenecek.`);
                await new Promise(r => setTimeout(r, Number(s.retryWait) || 1000));
              }
            }
          }
        } catch (err) {
          rec.error = err.message;
          if (s.continueOnFail && !controller.signal.aborted) {
            rec.status = 'error';
            const errItems = (inputs[0]?.length ? inputs[0] : [{ json: {} }]).map(i => ({ json: { ...i.json, hata: err.message } }));
            outputs[id] = outputsOf(n).map((_, k) => k === 0 ? errItems : []);
            rec.continued = true;
          } else {
            rec.status = 'error'; rec.d = now() - t0 - rec.t;
            rec.input = trimForStorage(rec.input);
            if (prev) mergeRec(prev, rec);
            emit('node:end', { nodeId: id, status: 'error', error: err.message, d: rec.d });
            throw err;
          }
        }
        rec.d = now() - t0 - rec.t;
        rec.output = clone(outputs[id]);
        if (prev) mergeRec(prev, rec);
        rec.output = trimForStorage(rec.output);
        rec.input = trimForStorage(rec.input);
        const edgeCounts = {};
        for (const e of edges) if (e.from === id && reach.has(e.to)) { const c = (outputs[id][e.fromPort] || []).length; exec.edges[e.id] = edgeCounts[e.id] = (prev ? exec.edges[e.id] || 0 : 0) + c; }
        emit('node:end', { nodeId: id, status: rec.status, d: rec.d, out: rec.output.map(o => o.length), in: rec.input.map(i => i.length), edges: edgeCounts, error: rec.error, runs: rec.runs });
      }
      // fold this iteration's record into the one from earlier iterations
      function mergeRec(prev, rec) {
        const cat = (a = [], b = []) => Array.from({ length: Math.max(a.length, b.length) }, (_, k) => [...(a[k] || []), ...(b[k] || [])]);
        rec.input = cat(prev.input, rec.input); rec.output = rec.output ? cat(prev.output, rec.output) : prev.output;
        rec.t = prev.t; rec.d += prev.d; rec.runs = (prev.runs || 1) + 1;
        if (rec.status === 'success' && prev.status === 'error') { rec.status = 'error'; rec.error = prev.error; }
      }
      async function runLoop(n, items, rec) {
        const size = Math.max(1, Math.floor(Number(n.params?.batchSize) || 1));
        const body = bodyOf.get(n.id) || new Set();
        const back = inner.filter(e => e.to === n.id && body.has(e.from));
        const max = Math.max(1, Number(n.params?.maxIterations) || 10000);
        const batches = []; for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
        if (batches.length > max) throw new Error(`Döngü ${batches.length} tur gerektiriyor; en fazla ${max} tura izin verilmiş`);
        const returned = [];
        iterating++;
        try {
          for (let k = 0; k < batches.length; k++) {
            if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu');
            for (const x of body) delete outputs[x];
            outputs[n.id] = [[], batches[k].map(it => ({ json: { ...it.json } }))];
            loopInfo.set(n.name, { tur: k, toplamTur: batches.length });
            await runSet(body, n.id);
            for (const e of back) returned.push(...clone(outputs[e.from]?.[e.fromPort] || []));
          }
        } finally { iterating--; }
        rec.logs.push(`${items.length} öğe, ${batches.length} turda işlendi`);
        return [back.length ? returned : items, items]; // port 1 shows everything that went round (its body already ran)
      }
      const loopInfo = new Map();

      function makeCtx(n, id, inputs, rec) {
        const nm = nodeMapFrom(outputs, nodes);
        const items = inputs[0] || [];
        const scopeBase = { nodeMap: nm, vars, execution: { id: exec.id, mode: exec.mode, onayAdresi: approvalUrl(resumeToken) }, workflow: { id: wf.id, name: wf.name } };
        const R = (val, item, i) => {
          if (typeof val !== 'string' || !val.includes('{{')) return val;
          try { return Expr.render(val, Expr.makeScope({ ...scopeBase, item, index: i, items })); }
          catch (err) { throw new Error(`İfade hatası (${val.trim().slice(0, 60)}): ${err.message}`); }
        };
        return {
          p: { ...defaults(n.type), ...clone(n.params || {}) }, node: n, wf, exec, mode: exec.mode, inputs, items, nm, vars, R,
          trigger: id === trig.id ? opts.triggerData : null,
          signal: controller.signal,
          loop: Object.fromEntries(loopInfo),
          checkAbort: () => { if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu'); },
          sleep: ms => new Promise((res, rej) => {
            if (controller.signal.aborted) return rej(controller.signal.reason || new Error('Çalıştırma durduruldu'));
            const onAbort = () => { clearTimeout(tm); rej(controller.signal.reason || new Error('Çalıştırma durduruldu')); };
            const tm = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); res(); }, ms);
            controller.signal.addEventListener('abort', onAbort, { once: true });
          }),
          log: (...a) => { if (rec.logs.length < 300) rec.logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
          credential: async credId => {
            if (!credId) throw new Error('Bu node için bir kimlik bilgisi seçin');
            const c = store.getCredentialData(credId);
            if (!c) throw new Error('Seçilen kimlik bilgisi silinmiş');
            return c;
          },
          // per-workflow memory that survives between runs (seen items, chat history…); `key` scopes it per node
          memory: (key = n.id) => { const d = staticData(); d[key] ??= {}; return d[key]; },
          saveMemory: () => store.saveStatic(wf.id),
          respond: res => opts.respond ? opts.respond(res) : false,
          approvalUrl: approvalUrl(resumeToken),
          waitApproval: (message, ms) => new Promise((resolve, reject) => {
            if (approvals.has(resumeToken)) return reject(new Error('Bu çalıştırma zaten bir onay bekliyor'));
            pauseTimeout(); rec.status = 'waiting'; emit('node:waiting', { nodeId: n.id });
            let tm = null;
            const end = (fn, v) => { clearTimeout(tm); approvals.delete(resumeToken); controller.signal.removeEventListener('abort', onAbort); armTimeout(); rec.status = 'running'; fn(v); };
            const onAbort = () => end(reject, controller.signal.reason || new Error('Çalıştırma durduruldu'));
            approvals.set(resumeToken, { execId: exec.id, workflowId: wf.id, workflow: wf.name, node: n.name, message, since: new Date().toISOString(), resolve: v => end(resolve, v) });
            if (ms > 0) tm = setTimeout(() => end(resolve, { karar: 'zaman aşımı', not: '', zaman: new Date().toISOString() }), Math.min(ms, 2 ** 31 - 1));
            controller.signal.addEventListener('abort', onAbort, { once: true });
          }),
          runSub: async (subId, subItems) => {
            const depth = (opts.depth || 0) + 1;
            if (depth > 8) throw new Error('Alt akışlar 8 seviyeden fazla iç içe çağrılamaz');
            const sub = store.getWorkflow(subId);
            if (!sub) throw new Error('Alt akış bulunamadı');
            const st = sub.nodes.find(x => x.type === 'subTrigger' && !x.disabled);
            if (!st) throw new Error(`"${sub.name}" akışında "Alt akış girişi" node'u yok`);
            const r = start(sub, { triggerId: st.id, triggerData: { items: clone(subItems) }, mode: 'alt akış', depth });
            rec.logs.push(`Alt akış çalıştırıldı: ${sub.name} (#${r.exec.id})`);
            // stopping or timing out the parent stops the child too
            const onAbort = () => stop(r.exec.id);
            controller.signal.addEventListener('abort', onAbort, { once: true });
            let fin;
            try { fin = await r.done; } finally { controller.signal.removeEventListener('abort', onAbort); }
            if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu');
            if (fin.status !== 'success') throw new Error(`Alt akış "${sub.name}" hata verdi: ${fin.error}`);
            return fin.lastOutput || [];
          },
        };
      }

      const mainOrder = topo(ownSet(reach, null));
      for (const id of mainOrder) { await runNode(id); if (outputs[id] !== undefined || exec.nodes[id]?.status !== 'skipped') lastNodeId = id; }
      exec.status = 'success';
    } catch (err) {
      exec.status = controller.signal.aborted && !/zaman aşımı/.test(err.message) ? 'stopped' : 'error';
      exec.error = err.message;
      exec.lastNode = lastRanId ? nodeById(lastRanId)?.name : null;
    } finally {
      pauseTimeout();
      if (holding) releaseSlot(wf.id);
    }
    exec.lastOutput = lastNodeId && outputs[lastNodeId] ? (outputs[lastNodeId][0] || []) : [];
    exec.stoppedAt = new Date().toISOString();
    exec.duration = now() - t0;
    running.delete(exec.id);
    const { lastOutput, ...stored } = exec;
    try { store.saveExecution(stored); } catch (e) { console.error('Çalıştırma kaydedilemedi:', e.message); }
    emit('exec:end', { status: exec.status, error: exec.error, duration: exec.duration });
    // editor test runs (node, webhook, form and chat tests) do not page anyone; a plain manual run still does, so the error workflow can be tried out
    if (exec.status === 'error' && exec.mode !== 'hata akışı' && !/testi$/.test(exec.mode)) triggerErrorWorkflow(wf, exec);
    for (const fn of endHooks) { try { fn(wf, exec); } catch (e) { console.error(e.message); } }
    return exec;
  })();
  return { exec, done };
}

const endHooks = [];
const onEnd = fn => endHooks.push(fn);

function triggerErrorWorkflow(wf, exec) {
  const ewId = wf.settings?.errorWorkflow;
  if (!ewId || ewId === wf.id) return;
  const ew = store.getWorkflow(ewId);
  const et = ew?.nodes.find(n => n.type === 'errorTrigger' && !n.disabled);
  if (!et) return;
  try {
    start(ew, { triggerId: et.id, mode: 'hata akışı', triggerData: { error: { workflow: { id: wf.id, name: wf.name }, execution: { id: exec.id, error: exec.error, lastNode: exec.lastNode, mode: exec.mode, startedAt: exec.startedAt } } } });
  } catch {}
}

function stop(execId) {
  const r = running.get(execId);
  if (!r) return false;
  r.controller.abort(new Error('Çalıştırma durduruldu'));
  return true;
}
const runningIds = () => [...running.keys()];

module.exports = { onEnd, start, stop, events, runningIds, queuedCount, pickTrigger, setPublicUrl, decide, approvals };
