'use strict';
/* Execution engine: runs a workflow graph from one trigger in topological order. */
const { EventEmitter } = require('events');
const Expr = require('./expr');
const store = require('./store');
const { NODES, outputsOf } = require('./nodes');

const events = new EventEmitter();
events.setMaxListeners(100);
const running = new Map(); // execId -> { exec, controller }
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
  const controller = new AbortController();
  running.set(exec.id, { exec, controller });
  const emit = (type, extra) => events.emit('event', { type, execId: exec.id, workflowId: wf.id, ...extra });

  const done = (async () => {
    const t0 = now();
    const timeoutS = Number(wf.settings?.timeout) || 0;
    const timer = timeoutS > 0 ? setTimeout(() => controller.abort(new Error(`Akış ${timeoutS} sn zaman aşımını geçti`)), timeoutS * 1000) : null;
    store.saveExecution(exec);
    emit('exec:start', { mode: exec.mode, trigger: exec.trigger, startedAt: exec.startedAt });
    const outputs = {};
    let lastNodeId = null;
    try {
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
      const indeg = new Map([...reach].map(id => [id, 0]));
      inner.forEach(e => indeg.set(e.to, indeg.get(e.to) + 1));
      const order = []; const q = [...reach].filter(id => indeg.get(id) === 0);
      while (q.length) { const id = q.shift(); order.push(id); for (const e of inner) if (e.from === id) { indeg.set(e.to, indeg.get(e.to) - 1); if (indeg.get(e.to) === 0) q.push(e.to); } }
      if (order.length < reach.size) throw new Error('Akışta döngü var. Döngüleri kaldırıp tekrar deneyin (tekrar için Alt akış ya da Kod kullanın).');

      const vars = store.getVariables();
      for (const id of order) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu');
        const n = nodeById(id); const def = NODES[n.type];
        if (!def || def.note) continue;
        let inputs = [];
        if (id !== trig.id) {
          inputs = Array.from({ length: def.inputs }, () => []);
          let any = false;
          for (const e of inner) {
            if (e.to !== id || !outputs[e.from]) continue;
            const items = outputs[e.from][e.fromPort] || [];
            if (inputs[e.toPort]) inputs[e.toPort].push(...clone(items));
            if (items.length) any = true;
          }
          if (!any) { exec.nodes[id] = { status: 'skipped', name: n.name, type: n.type, t: now() - t0, d: 0 }; exec.order.push(id); emit('node:end', { nodeId: id, status: 'skipped' }); continue; }
        }
        const rec = { status: 'running', name: n.name, type: n.type, input: inputs, output: null, t: now() - t0, d: 0, logs: [], tries: 0 };
        exec.nodes[id] = rec; exec.order.push(id); lastNodeId = id;
        emit('node:start', { nodeId: id });
        const s = n.settings || {};
        try {
          if (n.disabled) { outputs[id] = [inputs[0] || []]; rec.status = 'disabled'; }
          else if (opts.usePinData && Array.isArray(n.pinData)) { outputs[id] = [n.pinData.map(json => ({ json: clone(json) }))]; rec.status = 'success'; rec.pinned = true; }
          else {
            const maxTries = s.retryOnFail ? Math.max(1, Math.min(10, Number(s.maxTries) || 3)) : 1;
            for (let attempt = 1; ; attempt++) {
              rec.tries = attempt;
              try {
                const nm = nodeMapFrom(outputs, nodes);
                const items = inputs[0] || [];
                const scopeBase = { nodeMap: nm, vars, execution: { id: exec.id, mode: exec.mode }, workflow: { id: wf.id, name: wf.name } };
                const R = (val, item, i) => {
                  if (typeof val !== 'string' || !val.includes('{{')) return val;
                  try { return Expr.render(val, Expr.makeScope({ ...scopeBase, item, index: i, items })); }
                  catch (err) { throw new Error(`İfade hatası (${val.trim().slice(0, 60)}): ${err.message}`); }
                };
                const ctx = {
                  p: clone(n.params || {}), node: n, wf, exec, mode: exec.mode, inputs, items, nm, vars, R,
                  trigger: id === trig.id ? opts.triggerData : null,
                  signal: controller.signal,
                  checkAbort: () => { if (controller.signal.aborted) throw controller.signal.reason || new Error('Çalıştırma durduruldu'); },
                  sleep: ms => new Promise((res, rej) => {
                    const tm = setTimeout(res, ms);
                    controller.signal.addEventListener('abort', () => { clearTimeout(tm); rej(controller.signal.reason || new Error('Çalıştırma durduruldu')); }, { once: true });
                  }),
                  log: (...a) => { if (rec.logs.length < 300) rec.logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
                  credential: async credId => {
                    if (!credId) throw new Error('Bu node için bir kimlik bilgisi seçin');
                    const c = store.getCredentialData(credId);
                    if (!c) throw new Error('Seçilen kimlik bilgisi silinmiş');
                    return c;
                  },
                  respond: res => opts.respond ? opts.respond(res) : false,
                  runSub: async (subId, subItems) => {
                    const depth = (opts.depth || 0) + 1;
                    if (depth > 8) throw new Error('Alt akışlar 8 seviyeden fazla iç içe çağrılamaz');
                    const sub = store.getWorkflow(subId);
                    if (!sub) throw new Error('Alt akış bulunamadı');
                    const st = sub.nodes.find(x => x.type === 'subTrigger' && !x.disabled);
                    if (!st) throw new Error(`"${sub.name}" akışında "Alt akış girişi" node'u yok`);
                    const r = start(sub, { triggerId: st.id, triggerData: { items: clone(subItems) }, mode: 'alt akış', depth });
                    rec.logs.push(`Alt akış çalıştırıldı: ${sub.name} (#${r.exec.id})`);
                    const fin = await r.done;
                    if (fin.status !== 'success') throw new Error(`Alt akış "${sub.name}" hata verdi: ${fin.error}`);
                    return fin.lastOutput || [];
                  },
                };
                const res = await def.run(ctx);
                ctx.checkAbort();
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
            emit('node:end', { nodeId: id, status: 'error', error: err.message, d: rec.d });
            throw err;
          }
        }
        rec.d = now() - t0 - rec.t;
        rec.output = trimForStorage(clone(outputs[id]));
        rec.input = trimForStorage(rec.input);
        const edgeCounts = {};
        for (const e of edges) if (e.from === id && reach.has(e.to)) { exec.edges[e.id] = edgeCounts[e.id] = (outputs[id][e.fromPort] || []).length; }
        emit('node:end', { nodeId: id, status: rec.status, d: rec.d, out: outputs[id].map(o => o.length), in: inputs.map(i => i.length), edges: edgeCounts, error: rec.error });
      }
      exec.status = 'success';
    } catch (err) {
      exec.status = controller.signal.aborted && !/zaman aşımı/.test(err.message) ? 'stopped' : 'error';
      exec.error = err.message;
      exec.lastNode = lastNodeId ? nodeById(lastNodeId)?.name : null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    exec.lastOutput = lastNodeId && outputs[lastNodeId] ? (outputs[lastNodeId][0] || []) : [];
    exec.stoppedAt = new Date().toISOString();
    exec.duration = now() - t0;
    running.delete(exec.id);
    const { lastOutput, ...stored } = exec;
    store.saveExecution(stored);
    emit('exec:end', { status: exec.status, error: exec.error, duration: exec.duration });
    if (exec.status === 'error' && exec.mode !== 'hata akışı') triggerErrorWorkflow(wf, exec);
    return exec;
  })();
  return { exec, done };
}

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

module.exports = { start, stop, events, runningIds, pickTrigger };
