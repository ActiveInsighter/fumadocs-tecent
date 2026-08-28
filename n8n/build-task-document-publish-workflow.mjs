import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Builds "AnyWorkflow Task Document Publish": one publish job publishes the
// whole task tree (Task -> Event -> Act -> Message) as Fumadocs MDX pages,
// optional Markdown/PDF artifacts on the Blob store, and exactly one GitHub
// commit through the Git Data API.

const nodes = [];
const connections = {};

function addNode(name, type, parameters, extra = {}) {
  const node = {
    parameters,
    id: `task-publish-${nodes.length + 1}`,
    name,
    type,
    typeVersion: extra.typeVersion ?? 2,
    position: extra.position ?? [0, nodes.length * 220],
  };
  if (extra.retryOnFail !== undefined) node.retryOnFail = extra.retryOnFail;
  if (extra.maxTries !== undefined) node.maxTries = extra.maxTries;
  if (extra.waitBetweenTries !== undefined) node.waitBetweenTries = extra.waitBetweenTries;
  if (extra.webhookId !== undefined) node.webhookId = extra.webhookId;
  nodes.push(node);
  return name;
}

function addCode(name, jsCode, mode = 'runOnceForAllItems', position) {
  return addNode(name, 'n8n-nodes-base.code', { mode, jsCode }, {
    typeVersion: 2,
    position,
  });
}

function addHttp(name, parameters, position, extra = {}) {
  return addNode(name, 'n8n-nodes-base.httpRequest', parameters, {
    typeVersion: 4.2,
    position,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2_000,
    ...extra,
  });
}

function addIf(name, leftValue, operation, position, extraRight) {
  const condition = {
    id: `task-publish-condition-${nodes.length + 1}`,
    leftValue,
    rightValue: extraRight ?? '',
    operator: { type: 'boolean', operation, singleValue: true },
  };
  if (extraRight !== undefined) {
    condition.operator = { type: 'string', operation: 'equals' };
  }
  return addNode(name, 'n8n-nodes-base.if', {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
      conditions: [condition],
      combinator: 'and',
    },
  }, { typeVersion: 2.2, position });
}

function addMerge(name, position) {
  return addNode(name, 'n8n-nodes-base.merge', {
    mode: 'append',
    numberInputs: 2,
  }, { typeVersion: 3.2, position });
}

function connect(from, to, output = 0, input = 0) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
}

function pocketBaseHeaders() {
  return { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] };
}

function pocketBaseWriteHeaders() {
  return { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] };
}

function supabaseHeaders(prefer = 'return=representation') {
  return { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
    { name: 'Prefer', value: prefer },
  ] };
}

function githubHeaders(extra = []) {
  return { parameters: [
    { name: 'Authorization', value: '={{ \'Bearer \' + $env.GITHUB_TOKEN }}' },
    { name: 'Accept', value: 'application/vnd.github+json' },
    { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
    ...extra,
  ] };
}

const SHA256_CODE = `
function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;
  const l = bytes.length;
  const padded = new Uint8Array((((l + 9) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[l] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((l * 8) / 4294967296));
  view.setUint32(padded.length - 4, (l * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  let hex = '';
  for (const part of H) hex += part.toString(16).padStart(8, '0');
  return hex;
}`;

const validateEventCode = String.raw`
const input = $json;
const body = input.body && typeof input.body === 'object' ? input.body : input;
const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
const receivedSecret = headers['x-internal-key'] || headers['X-Internal-Key'];
const expectedSecret = $env.N8N_DOCUMENT_PUBLISH_SECRET;
if (typeof expectedSecret !== 'string' || expectedSecret.length < 16 || receivedSecret !== expectedSecret) {
  throw new Error('Task publish webhook authentication failed.');
}
if (
  body.schemaVersion !== 2 ||
  body.kind !== 'taskPublish' ||
  typeof body.eventId !== 'string' ||
  !/^[a-f0-9]{64}$/.test(body.eventId) ||
  typeof body.ownerId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.ownerId) ||
  typeof body.publishJobId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.publishJobId) ||
  typeof body.taskRecordId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.taskRecordId)
) {
  throw new Error('Task publish webhook payload is invalid.');
}
return {
  json: {
    eventId: body.eventId,
    ownerId: body.ownerId,
    publishJobId: body.publishJobId,
    taskRecordId: body.taskRecordId,
    source: 'anyworkflow',
  },
};`;

const mergePublishJobCode = String.raw`
const base = $('Validate Event').item.json;
const job = $json;
if (
  !job.id ||
  job.id !== base.publishJobId ||
  job.owner !== base.ownerId ||
  job.task !== base.taskRecordId
) {
  throw new Error('PocketBase returned an invalid or cross-owner publish job.');
}
const version = Number(job.version);
if (!Number.isInteger(version) || version < 1) {
  throw new Error('The publish job has an invalid version.');
}
const status = typeof job.status === 'string' ? job.status : '';
const rerunnable = status === 'queued' || status === 'failed';
return {
  json: {
    ...base,
    publishJobId: job.id,
    version,
    buildMd: job.buildMd === true,
    buildPdf: job.buildPdf === true,
    sourceChecksum: typeof job.sourceChecksum === 'string' ? job.sourceChecksum : '',
    jobStatus: status,
    exit: !rerunnable,
    exitReason: rerunnable ? '' : status,
  },
};`;

const publishAlreadyDoneCode = String.raw`
return {
  json: {
    accepted: true,
    skipped: true,
    reason: $json.exitReason || 'finished',
    publishJobId: $json.publishJobId,
    taskRecordId: $json.taskRecordId,
    version: $json.version,
  },
};`;

const mergeTaskCode = String.raw`
const base = $('Merge Publish Job').item.json;
const task = $json;
if (task.id !== base.taskRecordId || task.owner !== base.ownerId) {
  throw new Error('PocketBase returned an invalid or cross-owner task.');
}
if (task.status !== 'succeeded') {
  throw new Error('Task publishing requires a completed task (status=succeeded).');
}
if (task.metadataStatus !== 'ready') {
  throw new Error('Task publishing requires enriched metadata (metadataStatus=ready).');
}
const publishKey = typeof task.publishKey === 'string' ? task.publishKey : '';
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publishKey)) {
  throw new Error('The task has no valid publish key.');
}
return {
  json: {
    ...base,
    task,
  },
};`;

const prepareDocumentLookupsCode = String.raw`
const base = $('Merge Task').first().json;
const eventsResp = $('Get Events').first().json;
const actsResp = $('Get Acts').first().json;
const messagesResp = $('Get Messages').first().json;
const events = Array.isArray(eventsResp.items) ? eventsResp.items : [];
const acts = Array.isArray(actsResp.items) ? actsResp.items : [];
const messages = Array.isArray(messagesResp.items) ? messagesResp.items : [];
const documentIds = [
  base.taskRecordId,
  ...events.map((event) => event.id),
  ...acts.map((act) => act.id),
  ...messages.map((message) => message.id),
].map((recordId) => recordId + '-v' + base.version);
const chunks = [];
for (let index = 0; index < documentIds.length; index += 40) {
  chunks.push(documentIds.slice(index, index + 40));
}
return chunks.map((chunk) => ({
  json: {
    lookupUrl: $env.POCKETBASE_URL + '/api/collections/aw_documents/records?perPage=500&filter='
      + encodeURIComponent(chunk.map((documentId) => 'documentId = "' + documentId + '"').join(' || ')),
  },
}));`;

const mergeDocumentLookupsCode = String.raw`
const base = $('Merge Task').first().json;
const existing = [];
for (const item of $input.all()) {
  const records = Array.isArray(item.json.items) ? item.json.items : [];
  for (const record of records) {
    if (record.id && record.documentId) existing.push(record);
  }
}
return {
  json: {
    ...base,
    existingDocuments: existing,
  },
};`;

const buildSnapshotCode = String.raw`
const base = $('Merge Task').first().json;
const eventsResp = $('Get Events').first().json;
const actsResp = $('Get Acts').first().json;
const messagesResp = $('Get Messages').first().json;
const events = Array.isArray(eventsResp.items) ? eventsResp.items : [];
const acts = Array.isArray(actsResp.items) ? actsResp.items : [];
const messages = Array.isArray(messagesResp.items) ? messagesResp.items : [];
const PUBLISH_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DOCUMENTS = 500;
const MAX_MARKDOWN_BYTES = 1048576;
${''}${SHA256_CODE}
function cleanMarkdown(input, title) {
  const lines = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');
  let fenced = false;
  const cleaned = lines.map((line) => {
    if (/^\s*~~~/.test(line) || line.trimStart().startsWith(String.fromCharCode(96).repeat(3))) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    if (/^\s*(?:import|export)\s+/u.test(line)) return '';
    return line
      .replace(/<\/?(?:script|iframe|object|embed|style|link|meta)\b[^>]*>/giu, '')
      .replace(/<\/?[A-Za-z][^>]*>/gu, (tag) => tag.replace('<', '&lt;').replace('>', '&gt;'))
      .replace(/\]\(\s*javascript:[^)]+\)/giu, '](#)');
  }).join('\n').replace(/^---\s*\n[\s\S]*?\n---\s*\n/u, '').trim();
  const withTitle = /^#\s+/mu.test(cleaned) ? cleaned : '# ' + title + '\n\n' + cleaned;
  if (new TextEncoder().encode(withTitle).byteLength > MAX_MARKDOWN_BYTES) {
    throw new Error('A cleaned Markdown document exceeds the 1 MiB publish limit.');
  }
  return withTitle + '\n';
}
function displayTitle(record, fallback) {
  if (typeof record.manualTitle === 'string' && record.manualTitle.trim().length > 0) {
    return record.manualTitle.trim().slice(0, 512);
  }
  if (typeof record.autoTitle === 'string' && record.autoTitle.trim().length > 0) {
    return record.autoTitle.trim().slice(0, 512);
  }
  return fallback.slice(0, 512);
}
function displaySummary(record) {
  if (typeof record.manualSummary === 'string' && record.manualSummary.trim().length > 0) {
    return record.manualSummary.trim().slice(0, 2000);
  }
  return typeof record.autoSummary === 'string' ? record.autoSummary.trim().slice(0, 2000) : '';
}
function displayTags(record) {
  if (!Array.isArray(record.autoTags)) return [];
  return record.autoTags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 8);
}
function requirePublishKey(record, label) {
  const publishKey = typeof record.publishKey === 'string' ? record.publishKey : '';
  if (!PUBLISH_KEY_PATTERN.test(publishKey)) {
    throw new Error('The ' + label + ' has no valid publish key.');
  }
  return publishKey;
}
function buildIndexMdx(title, summary, childHeading, childLines) {
  const frontmatter = '---\n'
    + 'title: ' + JSON.stringify(title) + '\n'
    + 'description: ' + JSON.stringify(summary || title) + '\n'
    + '---\n\n';
  let body = '# ' + title + '\n\n';
  if (summary) body += summary + '\n\n';
  if (childLines.length > 0) {
    body += '## ' + childHeading + '\n\n' + childLines.map((line) => '- ' + line).join('\n') + '\n';
  }
  return frontmatter + body;
}
function metaJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}
const contentMessages = messages.filter(
  (message) => typeof message.assistantMarkdown === 'string' && message.assistantMarkdown.trim().length > 0,
);
if (contentMessages.length === 0) {
  throw new Error('The task has no messages with assistant content.');
}
const messagesByAct = new Map();
for (const message of contentMessages) {
  const list = messagesByAct.get(message.act) || [];
  list.push(message);
  messagesByAct.set(message.act, list);
}
for (const list of messagesByAct.values()) {
  list.sort((a, b) => (Number(a.nodeIndex) || 0) - (Number(b.nodeIndex) || 0) || a.id.localeCompare(b.id));
}
const contentActIds = new Set(messagesByAct.keys());
const actsByEvent = new Map();
for (const act of acts) {
  if (!contentActIds.has(act.id)) continue;
  const list = actsByEvent.get(act.event) || [];
  list.push(act);
  actsByEvent.set(act.event, list);
}
for (const list of actsByEvent.values()) {
  list.sort((a, b) => (Number(a.actIndex) || 0) - (Number(b.actIndex) || 0) || a.id.localeCompare(b.id));
}
const contentEventIds = new Set(actsByEvent.keys());
const orderedEvents = events
  .filter((event) => contentEventIds.has(event.id))
  .sort((a, b) => (Number(a.eventIndex) || 0) - (Number(b.eventIndex) || 0) || a.id.localeCompare(b.id));
if (orderedEvents.length + actsByEvent.size + contentMessages.length + 1 > MAX_DOCUMENTS) {
  throw new Error('The task exceeds the 500-document publish limit.');
}
const documents = [];
const files = [];
const addFile = (path, content) => {
  if (path.length > 1024) throw new Error('A generated Fumadocs path exceeds the limit.');
  files.push({ path, content });
};
const taskPublishKey = requirePublishKey(base.task, 'task');
const taskTitle = displayTitle(base.task, base.task.title || 'AI Task');
const taskSummary = displaySummary(base.task);
const taskTags = displayTags(base.task);
const taskPath = 'content/docs/tasks/' + taskPublishKey;
const eventSummaries = [];
documents.push({
  kind: 'task',
  recordId: base.task.id,
  sourceMessageRecordId: '',
  eventRecordId: '',
  actRecordId: '',
  title: taskTitle,
  summary: taskSummary,
  tags: taskTags,
  publishKey: taskPublishKey,
  fumadocsPath: taskPath + '/index.mdx',
  markdown: '',
});
const eventKeys = [];
for (const event of orderedEvents) {
  const eventKey = requirePublishKey(event, 'event');
  eventKeys.push(eventKey);
  const actNodes = actsByEvent.get(event.id) || [];
  const eventTitle = displayTitle(event, event.title || 'Phase');
  const eventSummary = displaySummary(event);
  const eventPath = taskPath + '/events/' + eventKey;
  const actTitles = actNodes.map((act) => displayTitle(act, act.title || 'Stage'));
  const actKeys = [];
  for (const act of actNodes) {
    const actKey = requirePublishKey(act, 'act');
    actKeys.push(actKey);
    const actTitle = displayTitle(act, act.title || 'Stage');
    const actSummary = displaySummary(act);
    const actPath = eventPath + '/acts/' + actKey;
    const actMessages = messagesByAct.get(act.id) || [];
    const messageTitles = actMessages.map((message) => {
      const heading = String(message.assistantMarkdown || '').match(/^#\s+(.+)$/mu)?.[1]?.trim();
      return displayTitle(message, heading || 'AI Document');
    });
    const messageKeys = [];
    for (const message of actMessages) {
      const messageKey = requirePublishKey(message, 'message');
      messageKeys.push(messageKey);
      const messageTitle = displayTitle(message, String(message.assistantMarkdown || '').match(/^#\s+(.+)$/mu)?.[1]?.trim() || 'AI Document');
      const messageSummary = displaySummary(message);
      const messageTags = displayTags(message);
      const markdown = cleanMarkdown(message.assistantMarkdown, messageTitle);
      const messagePath = actPath + '/messages/' + messageKey + '.mdx';
      addFile(messagePath, '---\n'
        + 'title: ' + JSON.stringify(messageTitle) + '\n'
        + 'description: ' + JSON.stringify(messageSummary || messageTitle) + '\n'
        + '---\n\n' + markdown);
      documents.push({
        kind: 'message',
        recordId: message.id,
        sourceMessageRecordId: message.id,
        eventRecordId: event.id,
        actRecordId: act.id,
        title: messageTitle,
        summary: messageSummary,
        tags: messageTags,
        publishKey: messageKey,
        fumadocsPath: messagePath,
        markdown,
      });
    }
    addFile(actPath + '/index.mdx', buildIndexMdx(actTitle, actSummary, 'Messages', messageTitles));
    addFile(actPath + '/meta.json', metaJson({ title: actTitle, pages: ['index', 'messages'] }));
    addFile(actPath + '/messages/meta.json', metaJson({ pages: messageKeys }));
    documents.push({
      kind: 'act',
      recordId: act.id,
      sourceMessageRecordId: '',
      eventRecordId: event.id,
      actRecordId: '',
      title: actTitle,
      summary: actSummary,
      tags: [],
      publishKey: actKey,
      fumadocsPath: actPath + '/index.mdx',
      markdown: '',
    });
  }
  addFile(eventPath + '/index.mdx', buildIndexMdx(eventTitle, eventSummary, 'Acts', actTitles));
  addFile(eventPath + '/meta.json', metaJson({ title: eventTitle, pages: ['index', 'acts'] }));
  addFile(eventPath + '/acts/meta.json', metaJson({ pages: actKeys }));
  documents.push({
    kind: 'event',
    recordId: event.id,
    sourceMessageRecordId: '',
    eventRecordId: '',
    actRecordId: '',
    title: eventTitle,
    summary: eventSummary,
    tags: [],
    publishKey: eventKey,
    fumadocsPath: eventPath + '/index.mdx',
    markdown: '',
  });
  eventSummaries.push({ key: eventKey, title: eventTitle });
}
addFile(taskPath + '/index.mdx', buildIndexMdx(taskTitle, taskSummary, 'Events', eventSummaries.map((entry) => entry.title)));
addFile(taskPath + '/meta.json', metaJson({ title: taskTitle, pages: ['index', 'events'] }));
addFile(taskPath + '/events/meta.json', metaJson({ pages: eventKeys }));
return {
  json: {
    eventId: base.eventId,
    ownerId: base.ownerId,
    taskRecordId: base.taskRecordId,
    publishJobId: base.publishJobId,
    version: base.version,
    buildMd: base.buildMd,
    buildPdf: base.buildPdf,
    sourceChecksum: base.sourceChecksum,
    taskPublishKey,
    taskTitle,
    documents: documents.map((document) => ({
      ...document,
      documentId: document.recordId + '-v' + base.version,
      version: base.version,
      sourceChecksum: sha256Hex(
        files.find((file) => file.path === document.fumadocsPath)?.content || '',
      ),
    })),
    files,
    eventCount: orderedEvents.length,
    actCount: actsByEvent.size,
    messageCount: contentMessages.length,
    documentCount: documents.length,
  },
};`;

const prepareDocumentWritesCode = String.raw`
const base = $('Build Snapshot').first().json;
const existingByDocumentId = new Map();
for (const record of $('Merge Document Lookups').first().json.existingDocuments || []) {
  existingByDocumentId.set(record.documentId, record);
}
const requests = base.documents.map((document) => {
  const body = {
    kind: document.kind,
    publishJob: base.publishJobId,
    task: base.taskRecordId,
    event: document.eventRecordId || '',
    act: document.actRecordId || '',
    sourceMessage: document.sourceMessageRecordId || '',
    publishKey: document.publishKey,
    slug: document.publishKey,
    title: document.title,
    summary: document.summary,
    tags: document.tags || [],
    status: 'processing',
    version: base.version,
    sourceChecksum: document.sourceChecksum,
    fumadocsPath: document.fumadocsPath,
    lastError: '',
  };
  const existing = existingByDocumentId.get(document.documentId);
  if (existing) {
    return {
      method: 'PATCH',
      url: '/api/collections/aw_documents/records/' + existing.id,
      body,
    };
  }
  return {
    method: 'POST',
    url: '/api/collections/aw_documents/records',
    body: { ...body, owner: base.ownerId, documentId: document.documentId },
  };
});
const chunks = [];
for (let index = 0; index < requests.length; index += 50) {
  chunks.push(requests.slice(index, index + 50));
}
return chunks.map((chunk) => ({
  json: {
    batchUrl: $env.POCKETBASE_URL + '/api/batch',
    batchBody: { requests: chunk },
  },
}));`;

const verifyDocumentsCode = String.raw`
const base = $('Build Snapshot').first().json;
const isEntryOk = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.error) return false;
  if (Number.isFinite(Number(entry.status))) {
    return Number(entry.status) >= 200 && Number(entry.status) < 300;
  }
  if (entry.body && typeof entry.body === 'object') return !entry.body.error;
  return typeof entry.id === 'string';
};
const recordIds = [];
for (const item of $input.all()) {
  const body = item.json;
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (!isEntryOk(entry)) throw new Error('PocketBase document batch write failed.');
    const recordId = entry?.body?.id || entry.id;
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new Error('PocketBase document batch write returned no record id.');
    }
    recordIds.push(recordId);
  }
}
if (recordIds.length !== base.documents.length) {
  throw new Error('PocketBase document batch write count mismatch.');
}
return {
  json: {
    ...base,
    documentRecords: base.documents.map((document, index) => ({
      kind: document.kind,
      recordId: document.recordId,
      documentRecordId: recordIds[index],
      sourceMessageRecordId: document.sourceMessageRecordId,
      publishKey: document.publishKey,
      title: document.title,
      summary: document.summary,
      tags: document.tags || [],
      fumadocsPath: document.fumadocsPath,
      markdown: document.markdown,
    })),
    documentCount: recordIds.length,
  },
};`;

const preparePdfJobsCode = String.raw`
const base = $('Verify Documents').first().json;
const messageDocuments = base.documentRecords.filter(
  (document) => document.kind === 'message' && typeof document.markdown === 'string' && document.markdown.length > 0,
);
if (messageDocuments.length === 0) {
  throw new Error('No message documents are available for PDF generation.');
}
if (messageDocuments.length > 200) {
  throw new Error('The task exceeds the 200-message PDF batch limit. Disable buildPdf or split the task.');
}
const supabaseUrl = typeof $env.MDTO_PDF_SUPABASE_URL === 'string'
  ? $env.MDTO_PDF_SUPABASE_URL.trim().replace(/\/+$/u, '')
  : '';
const serviceKey = typeof $env.MDTO_PDF_SUPABASE_SERVICE_KEY === 'string'
  ? $env.MDTO_PDF_SUPABASE_SERVICE_KEY.trim()
  : '';
const userId = typeof $env.MDTO_PDF_SUPABASE_USER_ID === 'string'
  ? $env.MDTO_PDF_SUPABASE_USER_ID.trim()
  : '';
const bucket = (typeof $env.MDTO_PDF_SUPABASE_BUCKET === 'string' && $env.MDTO_PDF_SUPABASE_BUCKET.trim())
  ? $env.MDTO_PDF_SUPABASE_BUCKET.trim()
  : 'pdf-jobs';
const theme = (typeof $env.MDTO_PDF_THEME === 'string' && $env.MDTO_PDF_THEME.trim())
  ? $env.MDTO_PDF_THEME.trim()
  : 'chatgpt-light';
const supabaseUrlIsValid = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu.test(supabaseUrl);
if (
  !supabaseUrlIsValid
  || !serviceKey
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(bucket)
  || !new Set(['chatgpt-light', 'academic', 'github']).has(theme)
) {
  throw new Error('mdTOpdf Supabase integration configuration is invalid.');
}
const repoBase = 'https://api.github.com/repos/ActiveInsighter/md-to-pdf';
const encodePath = (value) => value.split('/').map((part) => encodeURIComponent(part)).join('/');
return messageDocuments.map((document) => {
  const sourceFilename = document.publishKey + '.md';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,170}\.md$/u.test(sourceFilename)) {
    throw new Error('The PDF source filename is invalid: ' + sourceFilename);
  }
  const documentName = document.publishKey;
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const pdfJobId = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  const inputPath = 'jobs/' + pdfJobId + '/input.md';
  const outputPath = 'jobs/' + pdfJobId + '/output.pdf';
  return {
    json: {
      taskRecordId: base.taskRecordId,
      publishJobId: base.publishJobId,
      version: base.version,
      messageRecordId: document.recordId,
      documentRecordId: document.documentRecordId,
      markdown: document.markdown,
      pdfJobId,
      inputPath,
      outputPath,
      sourceFilename,
      jobInsertUrl: supabaseUrl + '/rest/v1/pdf_jobs',
      uploadUrl: supabaseUrl + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodePath(inputPath),
      markUploadedUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + pdfJobId + '&status=eq.created',
      queueUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + pdfJobId + '&status=eq.uploaded',
      downloadUrl: supabaseUrl + '/storage/v1/object/authenticated/' + encodeURIComponent(bucket) + '/' + encodePath(outputPath),
      dispatchUrl: repoBase + '/actions/workflows/build-pdf-api.yml/dispatches',
      pdfJobBody: {
        id: pdfJobId,
        user_id: userId,
        status: 'created',
        input_path: inputPath,
        assets_path: null,
        output_path: null,
        has_assets: false,
        theme,
        options: { breaks: true, toc: true },
        source_filename: sourceFilename,
        source_name: sourceFilename,
        document_name: documentName,
        output_filename: documentName + '.pdf',
        is_favorite: false,
      },
      dispatchPayload: {
        ref: 'main',
        inputs: { job_id: pdfJobId },
      },
    },
  };
});`;

const parsePdfJobsCode = String.raw`
const base = $('Prepare PDF Jobs').item.json;
const response = $json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf job creation failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
const job = rows[0];
if (!job || job.id !== base.pdfJobId || job.status !== 'created' || job.input_path !== base.inputPath) {
  throw new Error('mdTOpdf returned an invalid created job.');
}
return { json: base };`;

const parsePdfUploadsCode = String.raw`
const base = $('Parse PDF Jobs').item.json;
const response = $json;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf Markdown upload failed with status ' + statusCode + '.');
}
return { json: base };`;

const parsePdfQueuedCode = String.raw`
const base = $('Parse PDF Uploads').item.json;
const response = $json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf queue update failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
if (rows.length > 0 && rows[0].status !== 'queued') {
  throw new Error('mdTOpdf did not enter the queued state.');
}
return { json: base };`;

const preparePdfBatchPollCode = String.raw`
const responses = $input.all();
for (const item of responses) {
  const statusCode = Number(item.json?.statusCode);
  if (statusCode !== 204) {
    throw new Error('A PDF workflow dispatch failed with status ' + (statusCode || 'unknown') + '.');
  }
}
const queuedItems = $('Parse PDF Queued').all().map((item) => item.json);
const jobIds = queuedItems.map((item) => item.pdfJobId);
if (new Set(jobIds).size !== jobIds.length) {
  throw new Error('Duplicate PDF job IDs were generated.');
}
const base = $('Verify Documents').first().json;
const supabaseUrl = String($env.MDTO_PDF_SUPABASE_URL || '').trim().replace(/\/+$/u, '');
const batchFilter = 'in.(' + jobIds.map((jobId) => '"' + jobId + '"').join(',') + ')';
const batchStatusUrl = supabaseUrl + '/rest/v1/pdf_jobs?select=id,status,output_path,error_message&id='
  + encodeURIComponent(batchFilter);
return {
  json: {
    taskRecordId: base.taskRecordId,
    publishJobId: base.publishJobId,
    version: base.version,
    ownerId: base.ownerId,
    pdfJobs: queuedItems.map((item) => ({
      pdfJobId: item.pdfJobId,
      messageRecordId: item.messageRecordId,
      documentRecordId: item.documentRecordId,
      outputPath: item.outputPath,
      downloadUrl: item.downloadUrl,
    })),
    batchStatusUrl,
    pollCount: 0,
    pollDeadline: Date.now() + 30 * 60 * 1000,
    pdfBatchReady: false,
  },
};`;

const parsePdfBatchStatusCode = String.raw`
const state = $('Wait PDF Batch').first().json;
const response = $json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
  throw new Error('The PDF batch status lookup failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
const byId = new Map();
for (const row of rows) {
  if (row?.id) byId.set(row.id, row);
}
const jobs = (state.pdfJobs || []).map((job) => {
  const row = byId.get(job.pdfJobId);
  if (!row || typeof row.status !== 'string') {
    throw new Error('The PDF batch status response is missing a job.');
  }
  if (row.status === 'completed' && row.output_path !== job.outputPath) {
    throw new Error('A PDF job completed without the expected output path.');
  }
  return { ...job, status: row.status, errorMessage: row.error_message || '' };
});
const pollCount = Number(state.pollCount || 0) + 1;
if (pollCount > 90 || Date.now() > Number(state.pollDeadline || 0)) {
  throw new Error('Timed out waiting for the PDF batch.');
}
const failed = jobs.find((job) => job.status === 'failed');
if (failed) {
  throw new Error('A PDF build failed: ' + String(failed.errorMessage || failed.pdfJobId).slice(0, 500));
}
for (const job of jobs) {
  if (!new Set(['queued', 'building', 'uploading', 'completed']).has(job.status)) {
    throw new Error('The PDF batch returned an unexpected status: ' + job.status);
  }
}
return {
  json: {
    ...state,
    pdfJobs: jobs,
    pollCount,
    pdfBatchReady: jobs.every((job) => job.status === 'completed'),
  },
};`;

const preparePdfDownloadsCode = String.raw`
const state = $input.first().json;
if (!state.pdfBatchReady) throw new Error('The PDF batch is not ready for download.');
return state.pdfJobs.map((job) => ({ json: job }));`;

const collectPdfsCode = String.raw`
const downloads = $('Prepare PDF Downloads').all();
const responses = $input.all();
if (downloads.length !== responses.length) {
  throw new Error('A PDF download did not complete.');
}
const state = $('Prepare PDF Batch Poll').first().json;
${''}${SHA256_CODE}
const items = [];
for (let index = 0; index < responses.length; index += 1) {
  const job = downloads[index].json;
  const pdf = responses[index].binary?.data;
  if (!pdf) throw new Error('A PDF download returned no binary for job ' + job.pdfJobId + '.');
  const looksLikePdf = pdf.mimeType === 'application/pdf'
    || pdf.fileExtension?.toLowerCase() === 'pdf'
    || pdf.fileName?.toLowerCase().endsWith('.pdf');
  if (!looksLikePdf && !pdf.data) {
    throw new Error('A PDF download returned an invalid binary for job ' + job.pdfJobId + '.');
  }
  const byteSize = Number.isSafeInteger(Number(pdf.fileSize)) && Number(pdf.fileSize) > 0
    ? Number(pdf.fileSize)
    : Buffer.from(pdf.data || '', 'base64').byteLength;
  if (byteSize < 1) throw new Error('A PDF download has no measurable content.');
  items.push({
    json: {
      taskRecordId: state.taskRecordId,
      version: state.version,
      messageRecordId: job.messageRecordId,
      documentRecordId: job.documentRecordId,
      byteSize,
      checksum: sha256Hex(String(pdf.data || '')),
    },
    binary: {
      data: {
        ...pdf,
        mimeType: 'application/pdf',
        fileExtension: 'pdf',
      },
    },
  });
}
return items;`;

const skipPdfsCode = String.raw`
return { json: { pdfSkipped: true } };`;

const prepareArtifactUploadsCode = String.raw`
const base = $('Verify Documents').first().json;
const pdfItems = [];
for (const item of $input.all()) {
  if (item.binary?.data) pdfItems.push(item);
}
${''}${SHA256_CODE}
const messageDocuments = base.documentRecords.filter((document) => document.kind === 'message');
const items = [];
if (base.buildMd) {
  for (const document of messageDocuments) {
    items.push({
      json: {
        format: 'md',
        contentType: 'text/markdown',
        taskRecordId: base.taskRecordId,
        messageRecordId: document.recordId,
        documentRecordId: document.documentRecordId,
        version: base.version,
        body: document.markdown,
        byteSize: new TextEncoder().encode(document.markdown).byteLength,
        checksum: sha256Hex(document.markdown),
        downloadPath: '/download/tasks/' + base.taskRecordId + '/' + base.version + '/' + document.recordId + '/md',
      },
    });
  }
}
if (base.buildPdf) {
  const pdfByMessage = new Map(pdfItems.map((item) => [item.json.messageRecordId, item]));
  for (const document of messageDocuments) {
    const pdfItem = pdfByMessage.get(document.recordId);
    if (!pdfItem) {
      throw new Error('The PDF artifact for message ' + document.recordId + ' is missing.');
    }
    items.push({
      json: {
        format: 'pdf',
        contentType: 'application/pdf',
        taskRecordId: base.taskRecordId,
        messageRecordId: document.recordId,
        documentRecordId: document.documentRecordId,
        version: base.version,
        byteSize: pdfItem.json.byteSize,
        checksum: pdfItem.json.checksum,
        downloadPath: '/download/tasks/' + base.taskRecordId + '/' + base.version + '/' + document.recordId + '/pdf',
      },
      binary: pdfItem.binary,
    });
  }
}
if (items.length === 0) throw new Error('No artifacts were prepared.');
return items;`;

const verifySignerResponsesCode = String.raw`
const base = $('Prepare Artifact Uploads').item.json;
const signer = $json;
const expectedKey = 'documents/tasks/' + base.taskRecordId + '/v' + base.version
  + '/messages/' + base.messageRecordId + '/document.' + base.format;
if (
  signer.key !== expectedKey
  || typeof signer.uploadUrl !== 'string'
  || signer.contentType !== base.contentType
) {
  throw new Error('Fumadocs returned an invalid Blob upload signer response.');
}
return {
  json: { ...base, signer },
  binary: $('Prepare Artifact Uploads').item.binary,
};`;

const collectUploadsCode = String.raw`
const artifacts = $('Verify Signer Responses').all().map((item) => item.json);
const uploads = $input.all();
if (uploads.length !== artifacts.length) {
  throw new Error('An artifact upload did not complete.');
}
return {
  json: {
    artifactItems: artifacts,
    artifactUploadCount: artifacts.length,
  },
};`;

const prepareArtifactLookupsCode = String.raw`
const base = $('Verify Documents').first().json;
const artifactItems = $('Collect Uploads').first().json.artifactItems;
const documentIds = Array.from(new Set(artifactItems.map((artifact) => artifact.documentRecordId)));
const chunks = [];
for (let index = 0; index < documentIds.length; index += 40) {
  chunks.push(documentIds.slice(index, index + 40));
}
return chunks.map((chunk) => ({
  json: {
    lookupUrl: $env.POCKETBASE_URL + '/api/collections/aw_document_artifacts/records?perPage=500&filter='
      + encodeURIComponent(
        'version = ' + base.version + ' && ('
          + chunk.map((documentId) => 'document = "' + documentId + '"').join(' || ')
          + ')',
      ),
  },
}));`;

const mergeArtifactLookupsCode = String.raw`
const existing = [];
for (const item of $input.all()) {
  const records = Array.isArray(item.json.items) ? item.json.items : [];
  for (const record of records) {
    if (record.id && record.document) existing.push(record);
  }
}
return { json: { existingArtifacts: existing } };`;

const prepareArtifactWritesCode = String.raw`
const base = $('Verify Documents').first().json;
const artifactItems = $('Collect Uploads').first().json.artifactItems;
const existingByKey = new Map();
for (const record of $('Merge Artifact Lookups').first().json.existingArtifacts || []) {
  existingByKey.set(record.document + ':' + record.format, record);
}
const requests = artifactItems.map((artifact) => {
  const body = {
    publishJob: base.publishJobId,
    document: artifact.documentRecordId,
    version: artifact.version,
    format: artifact.format,
    blobKey: artifact.signer.key,
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    checksum: artifact.checksum,
    status: 'uploaded',
    downloadPath: artifact.downloadPath,
  };
  const existing = existingByKey.get(artifact.documentRecordId + ':' + artifact.format);
  if (existing) {
    return { method: 'PATCH', url: '/api/collections/aw_document_artifacts/records/' + existing.id, body };
  }
  return {
    method: 'POST',
    url: '/api/collections/aw_document_artifacts/records',
    body: { ...body, owner: base.ownerId },
  };
});
const chunks = [];
for (let index = 0; index < requests.length; index += 50) {
  chunks.push(requests.slice(index, index + 50));
}
return chunks.map((chunk) => ({
  json: {
    batchUrl: $env.POCKETBASE_URL + '/api/batch',
    batchBody: { requests: chunk },
  },
}));`;

const verifyArtifactRecordsCode = String.raw`
const isEntryOk = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.error) return false;
  if (Number.isFinite(Number(entry.status))) {
    return Number(entry.status) >= 200 && Number(entry.status) < 300;
  }
  if (entry.body && typeof entry.body === 'object') return !entry.body.error;
  return typeof entry.id === 'string';
};
const artifactItems = $('Collect Uploads').first().json.artifactItems;
const responses = $input.all();
const recordIds = [];
for (const item of responses) {
  const body = item.json;
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (!isEntryOk(entry)) throw new Error('PocketBase artifact batch write failed.');
    const recordId = entry?.body?.id || entry.id;
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new Error('PocketBase artifact batch write returned no record id.');
    }
    recordIds.push(recordId);
  }
}
if (recordIds.length !== artifactItems.length) {
  throw new Error('PocketBase artifact batch write count mismatch.');
}
return {
  json: {
    artifactRecords: artifactItems.map((artifact, index) => ({
      id: recordIds[index],
      documentRecordId: artifact.documentRecordId,
      format: artifact.format,
    })),
    artifactCount: recordIds.length,
  },
};`;

const skipArtifactsCode = String.raw`
return { json: { artifactsSkipped: true } };`;

const parseGitHubRootSidebarCode = String.raw`
const response = $json;
const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
  ? response.body
  : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 404) {
  throw new Error('GitHub sidebar lookup failed with status ' + statusCode + '.');
}
let sidebar = { pages: [] };
if (statusCode === 200) {
  if (typeof body.content !== 'string' || body.encoding !== 'base64') {
    throw new Error('GitHub sidebar lookup returned an invalid meta.json.');
  }
  try {
    sidebar = JSON.parse(Buffer.from(body.content.replace(/\s/gu, ''), 'base64').toString('utf8'));
  } catch {
    throw new Error('GitHub sidebar meta.json was not valid JSON.');
  }
}
if (!sidebar || typeof sidebar !== 'object' || !Array.isArray(sidebar.pages)) {
  throw new Error('GitHub sidebar meta.json has no pages array.');
}
if (sidebar.pages.some((page) => typeof page !== 'string')) {
  throw new Error('GitHub sidebar meta.json contains an invalid page entry.');
}
if (!sidebar.pages.includes('tasks')) sidebar.pages.push('tasks');
return {
  json: {
    rootSidebarContent: JSON.stringify(sidebar, null, 2) + '\n',
  },
};`;

const parseGitHubTasksIndexCode = String.raw`
const base = $('Verify Documents').first().json;
const response = $json;
const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
  ? response.body
  : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 404) {
  throw new Error('GitHub tasks index lookup failed with status ' + statusCode + '.');
}
let tasksIndex = { title: 'Tasks', pages: [] };
if (statusCode === 200) {
  if (typeof body.content !== 'string' || body.encoding !== 'base64') {
    throw new Error('GitHub tasks index lookup returned an invalid meta.json.');
  }
  try {
    tasksIndex = JSON.parse(Buffer.from(body.content.replace(/\s/gu, ''), 'base64').toString('utf8'));
  } catch {
    throw new Error('GitHub tasks index meta.json was not valid JSON.');
  }
}
if (!tasksIndex || typeof tasksIndex !== 'object' || !Array.isArray(tasksIndex.pages)) {
  throw new Error('GitHub tasks index meta.json has no pages array.');
}
if (tasksIndex.pages.some((page) => typeof page !== 'string')) {
  throw new Error('GitHub tasks index meta.json contains an invalid page entry.');
}
if (!tasksIndex.pages.includes(base.taskPublishKey)) tasksIndex.pages.push(base.taskPublishKey);
return {
  json: {
    tasksIndexContent: JSON.stringify(tasksIndex, null, 2) + '\n',
  },
};`;

const prepareGitHubBlobsCode = String.raw`
const base = $('Verify Documents').first().json;
const rootSidebar = $('Parse GitHub Root Sidebar').first().json.rootSidebarContent;
const tasksIndex = $('Parse GitHub Tasks Index').first().json.tasksIndexContent;
const files = [
  ...base.files,
  { path: 'content/docs/meta.json', content: rootSidebar },
  { path: 'content/docs/tasks/meta.json', content: tasksIndex },
];
if (files.length === 0) throw new Error('The task snapshot contains no files.');
return files.map((file) => ({
  json: {
    path: file.path,
    blobBody: { content: file.content, encoding: 'utf-8' },
  },
}));`;

const collectGitHubBlobsCode = String.raw`
const requests = $('Prepare GitHub Blobs').all();
const responses = $input.all();
if (requests.length !== responses.length) {
  throw new Error('A GitHub blob creation did not complete.');
}
const entries = requests.map((request, index) => {
  const sha = responses[index].json?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error('GitHub blob creation returned no valid SHA for ' + request.json.path + '.');
  }
  return { path: request.json.path, mode: '100644', type: 'blob', sha };
});
return {
  json: {
    treeEntries: entries,
    fileCount: entries.length,
  },
};`;

const parseGitHubRefCode = String.raw`
const ref = $json;
const commitSha = ref?.object?.sha;
if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/u.test(commitSha)) {
  throw new Error('GitHub returned no valid branch commit SHA.');
}
return { json: { commitSha } };`;

const parseGitHubCommitCode = String.raw`
const base = $('Parse GitHub Ref').item.json;
const commit = $json;
const baseTreeSha = commit?.tree?.sha;
if (typeof baseTreeSha !== 'string' || !/^[0-9a-f]{40}$/u.test(baseTreeSha)) {
  throw new Error('GitHub returned no valid base tree SHA.');
}
return { json: { commitSha: base.commitSha, baseTreeSha } };`;

const parseGitHubTreeCode = String.raw`
const base = $('Parse GitHub Commit').item.json;
const tree = $json;
const treeSha = tree?.sha;
if (typeof treeSha !== 'string' || !/^[0-9a-f]{40}$/u.test(treeSha)) {
  throw new Error('GitHub tree creation returned no valid SHA.');
}
return {
  json: {
    commitSha: base.commitSha,
    treeSha,
    treeUnchanged: treeSha === base.baseTreeSha,
  },
};`;

const parseGitHubCommitCreatedCode = String.raw`
const base = $('Parse GitHub Tree').item.json;
const commit = $json;
const newCommitSha = commit?.sha;
if (typeof newCommitSha !== 'string' || !/^[0-9a-f]{40}$/u.test(newCommitSha)) {
  throw new Error('GitHub commit creation returned no valid SHA.');
}
return { json: { newCommitSha } };`;

const verifyGitHubRefCode = String.raw`
const expected = $('Parse GitHub Commit Created').item.json.newCommitSha;
const ref = $json;
if (ref?.object?.sha !== expected) {
  throw new Error('GitHub did not advance the branch to the new commit.');
}
return { json: { commitSha: expected } };`;

const prepareFinalizationCode = String.raw`
const base = $('Verify Documents').first().json;
const publishedAt = new Date().toISOString();
let artifactRecords = [];
try {
  artifactRecords = $('Verify Artifact Records').first().json.artifactRecords || [];
} catch {
  artifactRecords = [];
}
const requests = base.documentRecords.map((document) => ({
  method: 'PATCH',
  url: '/api/collections/aw_documents/records/' + document.documentRecordId,
  body: { status: 'published', publishedAt, lastError: '' },
}));
for (const artifact of artifactRecords) {
  requests.push({
    method: 'PATCH',
    url: '/api/collections/aw_document_artifacts/records/' + artifact.id,
    body: { status: 'published' },
  });
}
const chunks = [];
for (let index = 0; index < requests.length; index += 50) {
  chunks.push(requests.slice(index, index + 50));
}
return chunks.map((chunk) => ({
  json: {
    batchUrl: $env.POCKETBASE_URL + '/api/batch',
    batchBody: { requests: chunk },
  },
}));`;

const verifyFinalizationCode = String.raw`
const base = $('Verify Documents').first().json;
const isEntryOk = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.error) return false;
  if (Number.isFinite(Number(entry.status))) {
    return Number(entry.status) >= 200 && Number(entry.status) < 300;
  }
  if (entry.body && typeof entry.body === 'object') return !entry.body.error;
  return typeof entry.id === 'string';
};
let artifactCount = 0;
try {
  artifactCount = Number($('Verify Artifact Records').first().json.artifactCount || 0);
} catch {
  artifactCount = 0;
}
for (const item of $input.all()) {
  const body = item.json;
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (!isEntryOk(entry)) throw new Error('PocketBase finalization batch write failed.');
  }
}
return {
  json: {
    finalized: true,
    documentCount: base.documentRecords.length,
    artifactCount,
    publishedAt: new Date().toISOString(),
  },
};`;

const publishCompleteCode = String.raw`
const base = $('Verify Documents').first().json;
const finalization = $('Verify Finalization').first().json;
const commitSha = $('Merge GitHub Commit').first().json.commitSha;
return {
  json: {
    accepted: true,
    published: true,
    publishJobId: base.publishJobId,
    taskRecordId: base.taskRecordId,
    taskPublishKey: base.taskPublishKey,
    version: base.version,
    documentCount: finalization.documentCount,
    artifactCount: finalization.artifactCount,
    commitSha,
    publishedAt: finalization.publishedAt,
  },
};`;

addNode('Webhook', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: 'anyworkflow-task-publish',
  responseMode: 'onReceived',
  options: {},
}, { typeVersion: 2.1, position: [0, 0], webhookId: 'anyworkflow-task-publish-v1' });
addCode('Validate Event', validateEventCode, 'runOnceForEachItem', [220, 0]);
addHttp('Get Publish Job', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + $json.publishJobId }}",
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [440, 0]);
addCode('Merge Publish Job', mergePublishJobCode, 'runOnceForEachItem', [660, 0]);
addIf('Is Job Finished', '={{ $json.exit }}', 'true', [880, 0]);
addCode('Publish Already Done', publishAlreadyDoneCode, 'runOnceForEachItem', [1100, -200]);
addHttp('Get Task', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records/' + $('Merge Publish Job').item.json.taskRecordId }}",
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1100, 200]);
addCode('Merge Task', mergeTaskCode, 'runOnceForEachItem', [1320, 200]);
addHttp('Lock Publish Job', {
  method: 'PATCH',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + $json.publishJobId }}",
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'snapshotting', startedAt: new Date().toISOString(), lastError: '' }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [1540, 200]);
addHttp('Get Events', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_events/records?perPage=500&sort=eventIndex&filter=' + encodeURIComponent('task = \"' + $('Merge Task').item.json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1760, 200]);
addHttp('Get Acts', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_acts/records?perPage=500&sort=actIndex&filter=' + encodeURIComponent('event.task = \"' + $('Merge Task').item.json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1980, 200]);
addHttp('Get Messages', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_messages/records?perPage=500&filter=' + encodeURIComponent('act.event.task = \"' + $('Merge Task').item.json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [2200, 200]);
addCode('Prepare Document Lookups', prepareDocumentLookupsCode, 'runOnceForAllItems', [2420, 200]);
addHttp('Get Existing Documents', {
  method: 'GET',
  url: '={{ $json.lookupUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: {
    response: { response: { responseFormat: 'json' } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [2640, 200]);
addCode('Merge Document Lookups', mergeDocumentLookupsCode, 'runOnceForAllItems', [2860, 200]);
addCode('Build Snapshot', buildSnapshotCode, 'runOnceForAllItems', [3080, 200]);
addCode('Prepare Document Writes', prepareDocumentWritesCode, 'runOnceForAllItems', [3300, 200]);
addHttp('Write Documents', {
  method: 'POST',
  url: '={{ $json.batchUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.batchBody) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [3520, 200]);
addCode('Verify Documents', verifyDocumentsCode, 'runOnceForAllItems', [3740, 200]);
addHttp('Mark Job Building', {
  method: 'PATCH',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + $json.publishJobId }}",
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify({ status: \'building\', totalDocuments: $json.documentCount, completedDocuments: 0 }) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [3960, 200]);

addIf('Build PDF', "={{ $('Verify Documents').first().json.buildPdf }}", 'true', [4180, 200]);
addCode('Prepare PDF Jobs', preparePdfJobsCode, 'runOnceForAllItems', [4400, 60]);
addHttp('Create PDF Jobs', {
  method: 'POST',
  url: "={{ $json.jobInsertUrl + '?on_conflict=id' }}",
  sendHeaders: true,
  headerParameters: supabaseHeaders('resolution=merge-duplicates,return=representation'),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.pdfJobBody) }}',
  options: {
    response: { response: { responseFormat: 'autodetect', fullResponse: true } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [4620, 60]);
addCode('Parse PDF Jobs', parsePdfJobsCode, 'runOnceForEachItem', [4840, 60]);
addHttp('Upload PDF Markdown', {
  method: 'POST',
  url: '={{ $json.uploadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Content-Type', value: 'text/markdown; charset=utf-8' },
    { name: 'Accept', value: 'application/json' },
    { name: 'x-upsert', value: 'true' },
    { name: 'cache-control', value: '3600' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'text/markdown',
  body: '={{ $json.markdown }}',
  options: {
    response: { response: { responseFormat: 'autodetect', fullResponse: true } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [5060, 60]);
addCode('Parse PDF Uploads', parsePdfUploadsCode, 'runOnceForEachItem', [5280, 60]);
addHttp('Advance PDF Jobs Uploaded', {
  method: 'PATCH',
  url: '={{ $json.markUploadedUrl }}',
  sendHeaders: true,
  headerParameters: supabaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'uploaded' }) }}",
  options: {
    response: { response: { responseFormat: 'autodetect', fullResponse: true } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [5500, 60]);
addHttp('Advance PDF Jobs Queued', {
  method: 'PATCH',
  url: "={{ $('Parse PDF Uploads').item.json.queueUrl }}",
  sendHeaders: true,
  headerParameters: supabaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'queued' }) }}",
  options: {
    response: { response: { responseFormat: 'autodetect', fullResponse: true } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [5720, 60]);
addCode('Parse PDF Queued', parsePdfQueuedCode, 'runOnceForEachItem', [5940, 60]);
addHttp('Dispatch PDF Batch', {
  method: 'POST',
  url: '={{ $json.dispatchUrl }}',
  sendHeaders: true,
  headerParameters: githubHeaders([{ name: 'Content-Type', value: 'application/json' }]),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.dispatchPayload) }}',
  options: {
    response: { response: { responseFormat: 'autodetect', fullResponse: true, neverError: true } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [6160, 60]);
addCode('Prepare PDF Batch Poll', preparePdfBatchPollCode, 'runOnceForAllItems', [6380, 60]);
addNode('Wait PDF Batch', 'n8n-nodes-base.wait', {
  resume: 'timeInterval',
  amount: 20,
  unit: 'seconds',
}, { typeVersion: 1.1, position: [6600, 60] });
addHttp('Get PDF Batch Status', {
  method: 'GET',
  url: '={{ $json.batchStatusUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json', fullResponse: true } } },
}, [6820, 60]);
addCode('Parse PDF Batch Status', parsePdfBatchStatusCode, 'runOnceForEachItem', [6820, 60]);
addIf('Is PDF Batch Ready', '={{ $json.pdfBatchReady }}', 'true', [7260, 60]);
addCode('Prepare PDF Downloads', preparePdfDownloadsCode, 'runOnceForAllItems', [7480, 60]);
addHttp('Download PDFs', {
  method: 'GET',
  url: '={{ $json.downloadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Accept', value: 'application/pdf' },
  ] },
  responseFormat: 'file',
  outputPropertyName: 'data',
  options: {
    response: { response: { responseFormat: 'file' } },
    batching: { batch: { batchSize: 3, batchInterval: 1000 } },
  },
}, [7700, 60]);
addCode('Collect PDFs', collectPdfsCode, 'runOnceForAllItems', [7920, 60]);
addCode('Skip PDFs', skipPdfsCode, 'runOnceForEachItem', [4400, 480]);
addMerge('Merge PDF Branch', [7920, 200]);

addIf('Build Artifacts', "={{ $('Verify Documents').first().json.buildMd || $('Verify Documents').first().json.buildPdf }}", 'true', [8140, 200]);
addCode('Prepare Artifact Uploads', prepareArtifactUploadsCode, 'runOnceForAllItems', [8360, 120]);
addHttp('Sign Artifact Uploads', {
  method: 'POST',
  url: "={{ ($env.FUMADOCS_BASE_URL || '').replace(/\\/+$/u, '') + '/api/blob/upload-url' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'X-Internal-Key', value: '={{ $env.FUMADOCS_BLOB_UPLOAD_KEY }}' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify({ taskRecordId: $json.taskRecordId, messageRecordId: $json.messageRecordId, version: $json.version, format: $json.format }) }}',
  options: {
    response: { response: { responseFormat: 'autodetect' } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [8580, 120]);
addCode('Verify Signer Responses', verifySignerResponsesCode, 'runOnceForEachItem', [8800, 120]);
addIf('Is Markdown Artifact', '={{ $json.format }}', 'equals', [9020, 120], 'md');
addHttp('Upload Markdown Artifacts', {
  method: 'PUT',
  url: '={{ $json.signer.uploadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'text/markdown' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'text/markdown',
  body: '={{ $json.body }}',
  options: {
    response: { response: { responseFormat: 'autodetect' } },
    batching: { batch: { batchSize: 5, batchInterval: 1000 } },
  },
}, [9240, 20]);
addHttp('Upload PDF Artifacts', {
  method: 'PUT',
  url: '={{ $json.signer.uploadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'application/pdf' },
  ] },
  sendBody: true,
  contentType: 'binaryData',
  inputDataFieldName: 'data',
  options: {
    response: { response: { responseFormat: 'autodetect' } },
    batching: { batch: { batchSize: 3, batchInterval: 1000 } },
  },
}, [9240, 240]);
addMerge('Merge Uploads', [9460, 120]);
addCode('Collect Uploads', collectUploadsCode, 'runOnceForAllItems', [9680, 120]);
addCode('Prepare Artifact Lookups', prepareArtifactLookupsCode, 'runOnceForAllItems', [9900, 120]);
addHttp('Get Existing Artifacts', {
  method: 'GET',
  url: '={{ $json.lookupUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: {
    response: { response: { responseFormat: 'json' } },
    batching: { batch: { batchSize: 5, batchInterval: 500 } },
  },
}, [10120, 120]);
addCode('Merge Artifact Lookups', mergeArtifactLookupsCode, 'runOnceForAllItems', [10340, 120]);
addCode('Prepare Artifact Writes', prepareArtifactWritesCode, 'runOnceForAllItems', [10560, 120]);
addHttp('Write Artifact Records', {
  method: 'POST',
  url: '={{ $json.batchUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.batchBody) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [10780, 120]);
addCode('Verify Artifact Records', verifyArtifactRecordsCode, 'runOnceForAllItems', [11000, 120]);
addCode('Skip Artifacts', skipArtifactsCode, 'runOnceForEachItem', [8360, 480]);
addMerge('Merge Artifact Branch', [11220, 200]);

addHttp('Get GitHub Root Sidebar', {
  method: 'GET',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/contents/content/docs/meta.json' }}",
  sendHeaders: true,
  headerParameters: githubHeaders(),
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [11440, 200]);
addCode('Parse GitHub Root Sidebar', parseGitHubRootSidebarCode, 'runOnceForEachItem', [11660, 200]);
addHttp('Get GitHub Tasks Index', {
  method: 'GET',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/contents/content/docs/tasks/meta.json' }}",
  sendHeaders: true,
  headerParameters: githubHeaders(),
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [11880, 200]);
addCode('Parse GitHub Tasks Index', parseGitHubTasksIndexCode, 'runOnceForEachItem', [12100, 200]);
addCode('Prepare GitHub Blobs', prepareGitHubBlobsCode, 'runOnceForAllItems', [12320, 200]);
addHttp('Create GitHub Blobs', {
  method: 'POST',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/blobs' }}",
  sendHeaders: true,
  headerParameters: githubHeaders([{ name: 'Content-Type', value: 'application/json' }]),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.blobBody) }}',
  options: {
    response: { response: { responseFormat: 'autodetect' } },
    batching: { batch: { batchSize: 8, batchInterval: 1000 } },
  },
}, [12540, 200]);
addCode('Collect GitHub Blobs', collectGitHubBlobsCode, 'runOnceForAllItems', [12760, 200]);
addHttp('Get GitHub Ref', {
  method: 'GET',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/ref/heads/' + ($env.GITHUB_BRANCH || 'main') }}",
  sendHeaders: true,
  headerParameters: githubHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [12980, 200]);
addCode('Parse GitHub Ref', parseGitHubRefCode, 'runOnceForEachItem', [13200, 200]);
addHttp('Get GitHub Commit', {
  method: 'GET',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/commits/' + $json.commitSha }}",
  sendHeaders: true,
  headerParameters: githubHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [13420, 200]);
addCode('Parse GitHub Commit', parseGitHubCommitCode, 'runOnceForEachItem', [13640, 200]);
addHttp('Create GitHub Tree', {
  method: 'POST',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/trees' }}",
  sendHeaders: true,
  headerParameters: githubHeaders([{ name: 'Content-Type', value: 'application/json' }]),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ base_tree: $json.baseTreeSha, tree: $('Collect GitHub Blobs').first().json.treeEntries }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [13860, 200]);
addCode('Parse GitHub Tree', parseGitHubTreeCode, 'runOnceForEachItem', [14080, 200]);
addIf('Is GitHub Tree Unchanged', '={{ $json.treeUnchanged }}', 'true', [14300, 200]);
addHttp('Create GitHub Commit', {
  method: 'POST',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/commits' }}",
  sendHeaders: true,
  headerParameters: githubHeaders([{ name: 'Content-Type', value: 'application/json' }]),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ message: 'docs: publish task ' + $('Verify Documents').first().json.taskPublishKey + ' (v' + $('Verify Documents').first().json.version + ')', tree: $json.treeSha, parents: [$json.commitSha] }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [14520, 320]);
addCode('Parse GitHub Commit Created', parseGitHubCommitCreatedCode, 'runOnceForEachItem', [14740, 320]);
addHttp('Update GitHub Ref', {
  method: 'PATCH',
  url: "={{ 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/git/refs/heads/' + ($env.GITHUB_BRANCH || 'main') }}",
  sendHeaders: true,
  headerParameters: githubHeaders([{ name: 'Content-Type', value: 'application/json' }]),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify({ sha: $json.newCommitSha }) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [14960, 320]);
addCode('Verify GitHub Ref', verifyGitHubRefCode, 'runOnceForEachItem', [15180, 320]);
addMerge('Merge GitHub Commit', [15400, 200]);
addCode('Prepare Finalization', prepareFinalizationCode, 'runOnceForAllItems', [15620, 200]);
addHttp('Write Finalization', {
  method: 'POST',
  url: '={{ $json.batchUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.batchBody) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [15840, 200]);
addCode('Verify Finalization', verifyFinalizationCode, 'runOnceForAllItems', [16060, 200]);
addHttp('Mark Job Published', {
  method: 'PATCH',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + $('Verify Documents').first().json.publishJobId }}",
  sendHeaders: true,
  headerParameters: pocketBaseWriteHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'published', completedDocuments: $('Verify Finalization').first().json.documentCount, publishedAt: $('Verify Finalization').first().json.publishedAt, lastError: '' }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [16280, 200]);
addCode('Publish Complete', publishCompleteCode, 'runOnceForEachItem', [16500, 200]);

connect('Webhook', 'Validate Event');
connect('Validate Event', 'Get Publish Job');
connect('Get Publish Job', 'Merge Publish Job');
connect('Merge Publish Job', 'Is Job Finished');
connect('Is Job Finished', 'Publish Already Done', 0);
connect('Is Job Finished', 'Get Task', 1);
connect('Get Task', 'Merge Task');
connect('Merge Task', 'Lock Publish Job');
connect('Lock Publish Job', 'Get Events');
connect('Get Events', 'Get Acts');
connect('Get Acts', 'Get Messages');
connect('Get Messages', 'Prepare Document Lookups');
connect('Prepare Document Lookups', 'Get Existing Documents');
connect('Get Existing Documents', 'Merge Document Lookups');
connect('Merge Document Lookups', 'Build Snapshot');
connect('Build Snapshot', 'Prepare Document Writes');
connect('Prepare Document Writes', 'Write Documents');
connect('Write Documents', 'Verify Documents');
connect('Verify Documents', 'Mark Job Building');
connect('Mark Job Building', 'Build PDF');
connect('Build PDF', 'Prepare PDF Jobs', 0);
connect('Build PDF', 'Skip PDFs', 1);
connect('Prepare PDF Jobs', 'Create PDF Jobs');
connect('Create PDF Jobs', 'Parse PDF Jobs');
connect('Parse PDF Jobs', 'Upload PDF Markdown');
connect('Upload PDF Markdown', 'Parse PDF Uploads');
connect('Parse PDF Uploads', 'Advance PDF Jobs Uploaded');
connect('Advance PDF Jobs Uploaded', 'Advance PDF Jobs Queued');
connect('Advance PDF Jobs Queued', 'Parse PDF Queued');
connect('Parse PDF Queued', 'Dispatch PDF Batch');
connect('Dispatch PDF Batch', 'Prepare PDF Batch Poll');
connect('Prepare PDF Batch Poll', 'Wait PDF Batch');
connect('Wait PDF Batch', 'Get PDF Batch Status');
connect('Get PDF Batch Status', 'Parse PDF Batch Status');
connect('Parse PDF Batch Status', 'Is PDF Batch Ready');
connect('Is PDF Batch Ready', 'Prepare PDF Downloads', 0);
connect('Is PDF Batch Ready', 'Wait PDF Batch', 1);
connect('Prepare PDF Downloads', 'Download PDFs');
connect('Download PDFs', 'Collect PDFs');
connect('Collect PDFs', 'Merge PDF Branch', 0, 0);
connect('Skip PDFs', 'Merge PDF Branch', 0, 1);
connect('Merge PDF Branch', 'Build Artifacts');
connect('Build Artifacts', 'Prepare Artifact Uploads', 0);
connect('Build Artifacts', 'Skip Artifacts', 1);
connect('Prepare Artifact Uploads', 'Sign Artifact Uploads');
connect('Sign Artifact Uploads', 'Verify Signer Responses');
connect('Verify Signer Responses', 'Is Markdown Artifact');
connect('Is Markdown Artifact', 'Upload Markdown Artifacts', 0);
connect('Is Markdown Artifact', 'Upload PDF Artifacts', 1);
connect('Upload Markdown Artifacts', 'Merge Uploads', 0, 0);
connect('Upload PDF Artifacts', 'Merge Uploads', 0, 1);
connect('Merge Uploads', 'Collect Uploads');
connect('Collect Uploads', 'Prepare Artifact Lookups');
connect('Prepare Artifact Lookups', 'Get Existing Artifacts');
connect('Get Existing Artifacts', 'Merge Artifact Lookups');
connect('Merge Artifact Lookups', 'Prepare Artifact Writes');
connect('Prepare Artifact Writes', 'Write Artifact Records');
connect('Write Artifact Records', 'Verify Artifact Records');
connect('Verify Artifact Records', 'Merge Artifact Branch', 0, 0);
connect('Skip Artifacts', 'Merge Artifact Branch', 0, 1);
connect('Merge Artifact Branch', 'Get GitHub Root Sidebar');
connect('Get GitHub Root Sidebar', 'Parse GitHub Root Sidebar');
connect('Parse GitHub Root Sidebar', 'Get GitHub Tasks Index');
connect('Get GitHub Tasks Index', 'Parse GitHub Tasks Index');
connect('Parse GitHub Tasks Index', 'Prepare GitHub Blobs');
connect('Prepare GitHub Blobs', 'Create GitHub Blobs');
connect('Create GitHub Blobs', 'Collect GitHub Blobs');
connect('Collect GitHub Blobs', 'Get GitHub Ref');
connect('Get GitHub Ref', 'Parse GitHub Ref');
connect('Parse GitHub Ref', 'Get GitHub Commit');
connect('Get GitHub Commit', 'Parse GitHub Commit');
connect('Parse GitHub Commit', 'Create GitHub Tree');
connect('Create GitHub Tree', 'Parse GitHub Tree');
connect('Parse GitHub Tree', 'Is GitHub Tree Unchanged');
connect('Is GitHub Tree Unchanged', 'Merge GitHub Commit', 0, 0);
connect('Is GitHub Tree Unchanged', 'Create GitHub Commit', 1);
connect('Create GitHub Commit', 'Parse GitHub Commit Created');
connect('Parse GitHub Commit Created', 'Update GitHub Ref');
connect('Update GitHub Ref', 'Verify GitHub Ref');
connect('Verify GitHub Ref', 'Merge GitHub Commit', 0, 1);
connect('Merge GitHub Commit', 'Prepare Finalization');
connect('Prepare Finalization', 'Write Finalization');
connect('Write Finalization', 'Verify Finalization');
connect('Verify Finalization', 'Mark Job Published');
connect('Mark Job Published', 'Publish Complete');

const workflow = {
  id: 'task-document-publish-v1',
  name: 'AnyWorkflow Task Document Publish',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    errorWorkflow: 'task-publish-error-v1',
    saveManualExecutions: true,
    saveExecutionProgress: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    executionTimeout: 3600,
  },
  versionId: 'task-document-publish-workflow-v1',
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(
    new URL('./task-document-publish.workflow.json', import.meta.url),
    `${JSON.stringify(workflow, null, 2)}\n`,
    'utf8',
  );
}
