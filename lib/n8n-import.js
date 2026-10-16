'use strict';
/* Converts an n8n workflow export into an 8n8 workflow. Common nodes are mapped with their settings;
   anything unknown becomes a "do nothing" node carrying a note, so the shape of the flow survives. */
const crypto = require('crypto');
const { defaults, NODES } = require('./nodes');

const id = () => crypto.randomBytes(6).toString('base64url');
const isN8n = j => j && Array.isArray(j.nodes) && j.connections && typeof j.connections === 'object' && j.nodes.some(n => /^(n8n-nodes-|@n8n\/)/.test(String(n.type)));

/* n8n expressions: "={{ $json.x }}" → "{{ $json.x }}", $('Node').item.json → $node["Node"].json */
function expr(v) {
  if (typeof v !== 'string') return v;
  let s = v.startsWith('=') ? v.slice(1) : v;
  s = s.replace(/\$\(\s*(['"])(.+?)\1\s*\)\.(?:item|first\(\)|last\(\)|all\(\)\[0\])\.json/g, (_, q, name) => `$node[${JSON.stringify(name)}].json`);
  s = s.replace(/\$node\[\s*'([^']+)'\s*\]/g, (_, name) => `$node[${JSON.stringify(name)}]`);
  s = s.replace(/\$input\.item\.json/g, '$json').replace(/\$item\(0\)\.\$node/g, '$node');
  return s;
}
const val = v => typeof v === 'string' ? expr(v) : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const OPMAP = { equals: 'eq', notEquals: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', larger: 'gt', largerEqual: 'gte', smaller: 'lt', smallerEqual: 'lte', contains: 'contains', notContains: 'notContains', startsWith: 'starts', endsWith: 'ends', empty: 'empty', isEmpty: 'empty', notEmpty: 'notEmpty', isNotEmpty: 'notEmpty', true: 'isTrue', false: 'isFalse', regex: 'regex', matchRegex: 'regex' };
function conds(p) {
  const c = p.conditions;
  if (c && Array.isArray(c.conditions)) { // v2 filter format
    return { conditions: c.conditions.map(x => ({ left: val(x.leftValue), op: OPMAP[x.operator?.operation] || 'eq', right: val(x.rightValue) })), combinator: c.combinator === 'or' ? 'or' : 'and' };
  }
  const out = [];
  for (const kind of ['string', 'number', 'boolean', 'dateTime']) for (const x of c?.[kind] || []) out.push({ left: val(x.value1), op: OPMAP[x.operation] || 'eq', right: val(x.value2) });
  return { conditions: out.length ? out : defaults('if').conditions, combinator: p.combineOperation === 'any' ? 'or' : 'and' };
}
function setFields(p) {
  if (p.assignments?.assignments) return p.assignments.assignments.map(a => ({ key: a.name, value: val(a.value) }));
  const out = [];
  for (const kind of ['string', 'number', 'boolean']) for (const x of p.values?.[kind] || []) out.push({ key: x.name, value: val(x.value) });
  if (p.fields?.values) for (const x of p.fields.values) out.push({ key: x.name, value: val(x.stringValue ?? x.numberValue ?? x.booleanValue ?? '') });
  return out;
}
function schedule(p) {
  const r = p.rule?.interval?.[0];
  if (p.rule?.interval?.find?.(x => x.field === 'cronExpression')) return { mode: 'cron', cron: p.rule.interval.find(x => x.field === 'cronExpression').expression };
  if (r) {
    const f = r.field;
    if (f === 'seconds') return { mode: 'interval', every: r.secondsInterval || 30, unit: 's' };
    if (f === 'minutes') return { mode: 'interval', every: r.minutesInterval || 5, unit: 'm' };
    if (f === 'hours') return { mode: 'interval', every: r.hoursInterval || 1, unit: 'h' };
    if (f === 'days') return { mode: 'cron', cron: `${r.triggerAtMinute ?? 0} ${r.triggerAtHour ?? 9} */${r.daysInterval || 1} * *` };
    if (f === 'weeks') return { mode: 'cron', cron: `${r.triggerAtMinute ?? 0} ${r.triggerAtHour ?? 9} * * ${(r.triggerAtDay || [1]).join(',')}` };
  }
  const t = p.triggerTimes?.item?.[0];
  if (t) return t.mode === 'everyMinute' ? { mode: 'interval', every: 1, unit: 'm' } : t.mode === 'everyHour' ? { mode: 'cron', cron: `${t.minute ?? 0} * * * *` } : t.mode === 'custom' ? { mode: 'cron', cron: t.cronExpression } : { mode: 'cron', cron: `${t.minute ?? 0} ${t.hour ?? 9} * * *` };
  return {};
}

/* each entry: n8n type suffix → (params, node) => [8n8 type, params] */
// n8n SQL nodes use $1 placeholders with a "query parameters" list, which matches the 8n8 database node
const sqlNode = p => {
  const op = { executeQuery: 'query', insert: 'insert', upsert: 'upsert', update: 'update', select: 'select', deleteTable: 'delete', delete: 'delete' }[p.operation] || 'query';
  const table = typeof p.table === 'object' ? p.table?.value || p.table?.cachedResultName : p.table;
  return ['database', { op, sql: val(p.query || ''), params: val(p.options?.queryReplacement || ''), table: table || '', key: p.columnToMatchOn || p.updateKey || 'id' }];
};
const MAP = {
  manualTrigger: () => ['manual', {}],
  scheduleTrigger: p => ['schedule', schedule(p)],
  cron: p => ['schedule', schedule(p)],
  interval: p => ['schedule', { mode: 'interval', every: p.interval || 1, unit: { seconds: 's', minutes: 'm', hours: 'h' }[p.unit] || 's' }],
  webhook: p => ['webhook', { method: p.httpMethod || 'GET', path: p.path || 'webhook', respond: { onReceived: 'immediately', lastNode: 'lastNode', responseNode: 'node' }[p.responseMode] || 'immediately' }],
  formTrigger: p => ['form', { title: p.formTitle || 'Form', description: p.formDescription || '', path: p.path || 'form', fields: (p.formFields?.values || []).map((f, i) => ({ label: f.fieldLabel || `Alan ${i + 1}`, name: String(f.fieldLabel || `alan${i + 1}`), type: { email: 'email', number: 'number', date: 'date', textarea: 'textarea' }[f.fieldType] || 'text', required: !!f.requiredField })), thanks: p.formSubmittedText || 'Teşekkürler!' }],
  errorTrigger: () => ['errorTrigger', {}],
  executeWorkflowTrigger: () => ['subTrigger', {}],
  chatTrigger: p => ['chatTrigger', { title: p.options?.title || 'Asistan', welcome: p.initialMessages || 'Merhaba!' }],
  rssFeedReadTrigger: p => ['rssTrigger', { url: val(p.feedUrl) }],
  rssFeedRead: p => ['rss', { url: val(p.url) }],
  telegramTrigger: () => ['telegramTrigger', {}],
  httpRequest: p => {
    const headers = (p.headerParameters?.parameters || []).map(x => ({ key: x.name, value: val(x.value) }));
    const query = (p.queryParameters?.parameters || []).map(x => ({ key: x.name, value: val(x.value) }));
    const body = p.jsonBody ? val(p.jsonBody) : p.bodyParameters?.parameters ? JSON.stringify(Object.fromEntries(p.bodyParameters.parameters.map(x => [x.name, val(x.value)])), null, 2) : undefined;
    return ['http', { method: p.method || p.requestMethod || 'GET', url: val(p.url), headers, query, ...(body ? { body, bodyType: 'json' } : {}) }];
  },
  set: p => ['set', { fields: setFields(p), keep: p.includeOtherFields ?? !p.keepOnlySet }],
  if: p => ['if', conds(p)],
  filter: p => ['filter', conds(p)],
  switch: p => {
    const rules = (p.rules?.values || p.rules?.rules || []).map((r, i) => ({ value: val(r.conditions?.conditions?.[0]?.rightValue ?? r.value ?? ''), label: r.outputKey || `kural ${i + 1}` }));
    const left = p.rules?.values?.[0]?.conditions?.conditions?.[0]?.leftValue ?? p.value1 ?? '{{ $json.durum }}';
    return ['switch', { value: val(left), rules: rules.length ? rules : defaults('switch').rules, fallback: p.options?.fallbackOutput !== 'none' }];
  },
  merge: p => ['merge', { mode: { append: 'append', combineByPosition: 'index', mergeByIndex: 'index', combineByFields: 'key', mergeByKey: 'key', combine: 'key' }[p.mode] || 'append', key: p.fieldsToMatchString || p.propertyName1 || 'id' }],
  code: p => ['code', { code: convertCode(p.jsCode || p.functionCode || '') }],
  function: p => ['code', { code: convertCode(p.functionCode || '') }],
  functionItem: p => ['code', { code: `return items.map(item => {\n  const $json = item.json;\n${p.functionCode || ''}\n  return item;\n});` }],
  sort: p => { const f = p.sortFieldsUi?.sortField?.[0]; return ['sort', { field: f?.fieldName || 'id', order: f?.order === 'descending' ? 'desc' : 'asc' }]; },
  limit: p => ['limit', { max: p.maxItems || 1, from: p.keep === 'lastItems' ? 'end' : 'start' }],
  removeDuplicates: p => ['dedupe', { fields: p.fieldsToCompare || '' }],
  itemLists: p => p.operation === 'aggregateItems' ? ['aggregate', {}] : p.operation === 'removeDuplicates' ? ['dedupe', {}] : ['splitOut', { field: p.fieldToSplitOut || 'liste' }],
  splitOut: p => ['splitOut', { field: p.fieldToSplitOut || 'liste' }],
  aggregate: p => ['aggregate', { mode: p.aggregate === 'aggregateAllItemData' ? 'all' : 'field', field: p.fieldsToAggregate?.fieldToAggregate?.[0]?.fieldToAggregate || '', output: p.destinationFieldName || 'liste' }],
  summarize: p => ['summarize', { groupBy: p.fieldsToSplitBy || '', field: p.fieldsToSummarize?.values?.[0]?.field || '', ops: 'adet, toplam, ortalama' }],
  splitInBatches: p => ['loop', { batchSize: p.batchSize || 1 }],
  wait: p => ['wait', { amount: p.amount || 1, unit: { seconds: 's', minutes: 'm', hours: 'h' }[p.unit] || 's' }],
  noOp: () => ['noop', {}],
  stopAndError: p => ['stopError', { message: val(p.errorMessage || 'Hata') }],
  respondToWebhook: p => ['respond', { type: p.respondWith === 'text' ? 'text' : p.respondWith === 'allIncomingItems' ? 'items' : 'json', body: val(p.responseBody || '{}'), status: p.options?.responseCode || 200 }],
  executeWorkflow: () => ['execWorkflow', {}],
  telegram: p => ['telegram', { chatId: val(p.chatId), text: val(p.text) }],
  emailSend: p => ['email', { from: val(p.fromEmail), to: val(p.toEmail), subject: val(p.subject), body: val(p.text || p.html || ''), format: p.html ? 'html' : 'text' }],
  slack: p => ['chatWebhook', { service: 'slack', text: val(p.text) }],
  discord: p => ['chatWebhook', { service: 'discord', text: val(p.content || p.text) }],
  html: p => ['html', { op: p.operation === 'convertToHtmlTable' ? 'text' : 'extract', source: p.dataPropertyName || p.sourceData === 'json' ? (p.dataPropertyName || 'data') : 'data', rules: (p.extractionValues?.values || []).map(v => ({ key: v.key, selector: v.cssSelector, attr: v.returnValue === 'attribute' ? v.attribute : v.returnValue === 'html' ? 'html' : '', all: !!v.returnArray })) }],
  htmlExtract: p => MAP.html(p),
  xml: p => ['xml', { op: p.mode === 'jsonToxml' ? 'toXml' : 'toJson', field: p.dataPropertyName || 'data' }],
  markdown: p => ['markdown', { op: p.mode === 'htmlToMarkdown' ? 'toMd' : 'toHtml', value: val(p.markdown || p.html || '') }],
  dateTime: () => ['datetime', {}],
  crypto: p => ['crypto', { op: p.action === 'hmac' ? 'hmac' : p.action === 'generate' ? 'uuid' : 'hash', algo: String(p.type || 'sha256').toLowerCase().replace('-', ''), value: val(p.value || '') }],
  readWriteFile: p => p.operation === 'write' ? ['writeFile', { path: val(p.fileName || 'cikti.txt').replace(/^.*[/\\]/, '') }] : ['readFile', { path: val(p.fileSelector || 'dosya.txt').replace(/^.*[/\\]/, '') }],
  stickyNote: p => ['note', { text: String(p.content || '').replace(/^#+\s*/gm, ''), color: 'yellow' }],
  postgres: p => sqlNode(p),
  mySql: p => sqlNode(p),
  googleSheets: p => ['sheets', { sheet: val(p.documentId?.value ?? p.sheetId ?? p.documentId ?? ''), tab: String(p.sheetName?.cachedResultName || p.sheetName?.value || p.range?.split('!')[0] || 'Sayfa1'), op: { append: 'append', appendOrUpdate: 'update', update: 'update', clear: 'clear' }[p.operation] || 'read', key: p.columnToMatchOn || p.columns?.matchingColumns?.[0] || 'id' }],
  agent: p => ['agent', { prompt: val(p.text || '{{ $json.chatInput }}'), system: val(p.options?.systemMessage || defaults('agent').system) }],
  lmChatAnthropic: null, // model sub-nodes are folded into the agent
  memoryBufferWindow: null,
};
function convertCode(code) {
  // n8n Code node: $input.all() and items[].json work the same here; `return items` style is fine.
  return `// n8n'den aktarıldı; gerekirse düzenleyin.\n${String(code).replace(/\$\(\s*(['"])(.+?)\1\s*\)\.(?:item|first\(\))\.json/g, (_, q, n) => `$node[${JSON.stringify(n)}].json`)}`;
}

function convertN8n(j) {
  const nodes = [], byName = new Map(), notes = [];
  for (const n of j.nodes) {
    const suffix = String(n.type).split('.').pop();
    const fn = MAP[suffix];
    if (fn === null) continue; // AI sub-nodes
    let type, params;
    if (fn) [type, params] = fn(n.parameters || {}, n);
    if (!type || !NODES[type]) { type = 'noop'; params = {}; notes.push(`"${n.name}" (${n.type}) karşılığı olmadığı için "Hiçbir şey yapma" node'u oldu`); }
    const pos = Array.isArray(n.position) ? n.position : [nodes.length * 300, 0];
    const node = { id: id(), type, name: String(n.name), x: Math.round(pos[0]), y: Math.round(pos[1]), params: { ...defaults(type), ...params }, disabled: !!n.disabled, settings: { ...(n.notes ? { notes: n.notes } : {}), ...(type === 'noop' && !fn ? { notes: `n8n: ${n.type}` } : {}), ...(n.retryOnFail ? { retryOnFail: true, maxTries: n.maxTries || 3, retryWait: n.waitBetweenTries || 1000 } : {}), ...(n.continueOnFail || n.onError === 'continueRegularOutput' ? { continueOnFail: true } : {}) } };
    if (n.pinData) node.pinData = n.pinData;
    nodes.push(node); byName.set(n.name, node);
  }
  const edges = [];
  for (const [from, conn] of Object.entries(j.connections || {})) {
    const a = byName.get(from); if (!a) continue;
    (conn.main || []).forEach((targets, port) => (targets || []).forEach(t => { const b = byName.get(t.node); if (b) edges.push({ id: id(), from: a.id, fromPort: port, to: b.id, toPort: t.index || 0 }); }));
    // AI tool/model connections (ai_tool, ai_languageModel…) have no 8n8 counterpart
  }
  if (j.pinData) for (const [name, items] of Object.entries(j.pinData)) { const n = byName.get(name); if (n && Array.isArray(items)) n.pinData = items.map(i => i.json ?? i); }
  // normalise coordinates so the flow starts near the origin
  const minX = Math.min(...nodes.map(n => n.x), 0), minY = Math.min(...nodes.map(n => n.y), 0);
  for (const n of nodes) { n.x -= minX; n.y -= minY; }
  return { workflow: { name: j.name || 'n8n\'den aktarılan akış', nodes, edges }, notes };
}

module.exports = { isN8n, convertN8n, expr };
