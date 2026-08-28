import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Builds "AnyWorkflow Task Metadata Enrichment": task-level metadata
// enrichment (message -> act -> event -> task) followed by publish job
// creation and the trigger for "AnyWorkflow Task Document Publish".

const nodes = [];
const connections = {};

function addNode(name, type, parameters, extra = {}) {
  const node = {
    parameters,
    id: `task-metadata-${nodes.length + 1}`,
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
    id: `task-metadata-condition-${nodes.length + 1}`,
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

function connect(from, to, output = 0, input = 0) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
}

const validateEventCode = String.raw`
const input = $json;
const body = input.body && typeof input.body === 'object' ? input.body : input;
const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
const receivedSecret = headers['x-internal-key'] || headers['X-Internal-Key'];
const expectedSecret = $env.N8N_DOCUMENT_PUBLISH_SECRET;
if (typeof expectedSecret !== 'string' || expectedSecret.length < 16 || receivedSecret !== expectedSecret) {
  throw new Error('Task metadata webhook authentication failed.');
}
if (
  body.schemaVersion !== 2 ||
  body.kind !== 'task' ||
  typeof body.eventId !== 'string' ||
  !/^[a-f0-9]{64}$/.test(body.eventId) ||
  typeof body.ownerId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.ownerId) ||
  typeof body.taskRecordId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.taskRecordId) ||
  typeof body.checksum !== 'string' ||
  !/^[a-f0-9]{64}$/.test(body.checksum)
) {
  throw new Error('Task metadata webhook payload is invalid.');
}
return {
  json: {
    eventId: body.eventId,
    ownerId: body.ownerId,
    taskRecordId: body.taskRecordId,
    checksum: body.checksum,
    buildMd: body.buildMd === undefined ? true : body.buildMd === true,
    buildPdf: body.buildPdf === undefined ? true : body.buildPdf === true,
    source: 'anyworkflow',
  },
};`;

const mergeTaskCode = String.raw`
const base = $('Validate Event').item.json;
const task = $json;
if (task.id !== base.taskRecordId || task.owner !== base.ownerId) {
  throw new Error('PocketBase returned an invalid or cross-owner task.');
}
if (task.status !== 'succeeded') {
  throw new Error('Task metadata enrichment requires a completed task (status=succeeded).');
}
return {
  json: {
    ...base,
    task,
    metadataReady: task.metadataStatus === 'ready',
  },
};`;

const evaluateJobStateCode = String.raw`
const base = $('Merge Task').item.json;
const result = $json;
const jobs = Array.isArray(result.items) ? result.items : [];
if (jobs.length > 1) throw new Error('PocketBase returned duplicate publish job versions.');
const latest = jobs[0] || null;
const latestStatus = typeof latest?.status === 'string' ? latest.status : '';
const duplicate = Boolean(
  latest &&
  latestStatus === 'published' &&
  latest.sourceChecksum === base.checksum
);
const inProgress = Boolean(
  latest &&
  ['queued', 'snapshotting', 'building', 'uploading', 'committing'].includes(latestStatus)
);
return {
  json: {
    ...base,
    latestPublishJob: latest || null,
    duplicate,
    inProgress,
    nextVersion: Math.max(0, Number(latest?.version) || 0) + 1,
  },
};`;

const buildTreeCode = String.raw`
const base = $('Evaluate Job State').first().json;
const eventsResp = $('Get Events').first().json;
const actsResp = $('Get Acts').first().json;
const messagesResp = $('Get Messages').first().json;
const events = Array.isArray(eventsResp.items) ? eventsResp.items : [];
const acts = Array.isArray(actsResp.items) ? actsResp.items : [];
const messages = Array.isArray(messagesResp.items) ? messagesResp.items : [];
if (
  (eventsResp.totalItems || 0) > 500 ||
  (actsResp.totalItems || 0) > 500 ||
  (messagesResp.totalItems || 0) > 500
) {
  throw new Error('The task exceeds the 500-per-level publish batch limit.');
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
const tree = {
  task: base.task,
  events: orderedEvents.map((event) => ({
    event,
    acts: (actsByEvent.get(event.id) || []).map((act) => ({
      act,
      messages: messagesByAct.get(act.id) || [],
    })),
  })),
};
return {
  json: {
    ...base,
    tree,
    eventCount: orderedEvents.length,
    actCount: actsByEvent.size,
    messageCount: contentMessages.length,
  },
};`;

const prepareMessageRequestsCode = String.raw`
const base = $('Build Tree').first().json;
const system = 'You normalize an AI answer into document metadata. Return only JSON with title, slug, summary, and tags. title is a concise human title in the original language; slug uses lowercase ASCII letters, numbers, and hyphens only; summary is at most 300 Chinese characters; tags is an array of at most 8 short strings. Do not invent technical claims.';
const truncate = (value, max) => (value.length > max ? value.slice(0, max) : value);
const items = [];
for (const eventNode of base.tree.events) {
  for (const actNode of eventNode.acts) {
    for (const message of actNode.messages) {
      const heading = String(message.assistantMarkdown || '').match(/^#\s+(.+)$/mu)?.[1]?.trim();
      items.push({
        json: {
          recordId: message.id,
          existingPublishKey: typeof message.publishKey === 'string' ? message.publishKey : '',
          fallbackTitle: (heading || 'AI Document').slice(0, 512),
          newApiRequest: {
            model: $env.NEW_API_MODEL,
            temperature: 0.2,
            stream: false,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: 'Original user request:\n' + truncate(message.userMarkdown || '', 8000)
                  + '\n\nAssistant answer:\n' + truncate(message.assistantMarkdown || '', 16000),
              },
            ],
          },
        },
      });
    }
  }
}
return items;`;

const parseMetadataBodyCode = `
const base = $('${'$'}{LEVEL_SOURCE}').item.json;
const response = $json;
const responseBody = response?.body && typeof response.body === 'object' && !Array.isArray(response.body)
  ? response.body
  : response;
if (responseBody?.error && typeof responseBody.error.message === 'string') {
  throw new Error('New API ${'$'}{LEVEL_NAME} metadata request failed: ' + responseBody.error.message.slice(0, 300));
}
let raw = responseBody?.choices?.[0]?.message?.content;
if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('New API returned no ${'$'}{LEVEL_NAME} metadata.');
const fence = String.fromCharCode(96).repeat(3);
raw = raw.trim().replace(new RegExp('^' + fence + '(?:json)?\\\\s*', 'iu'), '').replace(new RegExp('\\\\s*' + fence + '$', 'u'), '');
let metadata;
try {
  metadata = JSON.parse(raw);
} catch {
  throw new Error('New API ${'$'}{LEVEL_NAME} metadata was not valid JSON.');
}
const title = typeof metadata.title === 'string' && metadata.title.trim().length > 0
  ? metadata.title.trim().slice(0, 512)
  : base.fallbackTitle;
const candidateSlug = typeof metadata.slug === 'string' ? metadata.slug.trim().toLowerCase() : '';
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidateSlug) && candidateSlug.length <= 96
  ? candidateSlug
  : 'document';
const summary = typeof metadata.summary === 'string' ? metadata.summary.trim().slice(0, 2000) : '';
const tags = Array.isArray(metadata.tags)
  ? metadata.tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 8)
  : [];
const publishKey = base.existingPublishKey || (slug + '-' + base.recordId.slice(-6));
return {
  json: {
    recordId: base.recordId,
    eventId: base.eventId,
    actId: base.actId,
    metadata: { title, slug, summary, tags, publishKey },
  },
};`;

function parseMetadataCode(levelSource, levelName) {
  return parseMetadataBodyCode
    .replaceAll('${LEVEL_SOURCE}', levelSource)
    .replaceAll('${LEVEL_NAME}', levelName);
}

const aggregateMessagesCode = String.raw`
const base = $('Build Tree').first().json;
const messageMetas = $('Parse Message Metadata').all().map((item) => item.json);
const metaByMessage = new Map(messageMetas.map((meta) => [meta.recordId, meta]));
const system = 'You name one stage of an AI-assisted workflow based on its child message summaries. Return only JSON with title, slug, and summary. title is a concise human title in the original language; slug uses lowercase ASCII letters, numbers, and hyphens only; summary is at most 200 Chinese characters. Do not invent technical claims.';
const items = [];
for (const eventNode of base.tree.events) {
  for (const actNode of eventNode.acts) {
    const childLines = actNode.messages
      .map((message) => {
        const meta = metaByMessage.get(message.id);
        return meta ? '- ' + meta.metadata.title + ': ' + meta.metadata.summary : '';
      })
      .filter(Boolean)
      .join('\n');
    items.push({
      json: {
        recordId: actNode.act.id,
        eventId: eventNode.event.id,
        existingPublishKey: typeof actNode.act.publishKey === 'string' ? actNode.act.publishKey : '',
        fallbackTitle: (actNode.act.title || 'Stage').slice(0, 512),
        newApiRequest: {
          model: $env.NEW_API_MODEL,
          temperature: 0.2,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: 'Act raw title:\n' + (actNode.act.title || '(none)') + '\n\nChild messages:\n' + childLines,
            },
          ],
        },
      },
    });
  }
}
return items;`;

const aggregateActsCode = String.raw`
const base = $('Build Tree').first().json;
const actMetas = $('Parse Act Metadata').all().map((item) => item.json);
const metaByAct = new Map(actMetas.map((meta) => [meta.recordId, meta]));
const system = 'You name one phase of an AI-assisted workflow based on its stage summaries. Return only JSON with title, slug, and summary. title is a concise human title in the original language; slug uses lowercase ASCII letters, numbers, and hyphens only; summary is at most 200 Chinese characters. Do not invent technical claims.';
const items = [];
for (const eventNode of base.tree.events) {
  const childLines = eventNode.acts
    .map((actNode) => {
      const meta = metaByAct.get(actNode.act.id);
      return meta ? '- ' + meta.metadata.title + ': ' + meta.metadata.summary : '';
    })
    .filter(Boolean)
    .join('\n');
  items.push({
    json: {
      recordId: eventNode.event.id,
      existingPublishKey: typeof eventNode.event.publishKey === 'string' ? eventNode.event.publishKey : '',
      fallbackTitle: (eventNode.event.title || 'Phase').slice(0, 512),
      newApiRequest: {
        model: $env.NEW_API_MODEL,
        temperature: 0.2,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: 'Event raw title:\n' + (eventNode.event.title || '(none)') + '\n\nChild acts:\n' + childLines,
          },
        ],
      },
    },
  });
}
return items;`;

const aggregateEventsCode = String.raw`
const base = $('Build Tree').first().json;
const eventMetas = $('Parse Event Metadata').all().map((item) => item.json);
const childLines = eventMetas
  .map((meta) => '- ' + meta.metadata.title + ': ' + meta.metadata.summary)
  .join('\n');
const system = 'You name an AI-assisted workflow task based on its phase summaries. Return only JSON with title, slug, summary, and tags. title is a concise human title in the original language; slug uses lowercase ASCII letters, numbers, and hyphens only; summary is at most 300 Chinese characters; tags is an array of at most 8 short strings. Do not invent technical claims.';
return [{
  json: {
    recordId: base.taskRecordId,
    existingPublishKey: typeof base.task.publishKey === 'string' ? base.task.publishKey : '',
    fallbackTitle: (base.task.title || 'AI Task').slice(0, 512),
    newApiRequest: {
      model: $env.NEW_API_MODEL,
      temperature: 0.2,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: 'Task raw title:\n' + (base.task.title || '(none)') + '\n\nEvents:\n' + childLines,
        },
      ],
    },
  },
}];`;

const buildMetadataWritesCode = String.raw`
const base = $('Evaluate Job State').first().json;
const taskMeta = $('Parse Task Metadata').first().json;
const messageMetas = $('Parse Message Metadata').all().map((item) => item.json);
const actMetas = $('Parse Act Metadata').all().map((item) => item.json);
const eventMetas = $('Parse Event Metadata').all().map((item) => item.json);
const requests = [];
for (const meta of messageMetas) {
  requests.push({
    method: 'PATCH',
    url: '/api/collections/aw_messages/records/' + meta.recordId,
    body: {
      autoTitle: meta.metadata.title,
      autoSlug: meta.metadata.slug,
      autoSummary: meta.metadata.summary,
      autoTags: meta.metadata.tags,
      publishKey: meta.metadata.publishKey,
    },
  });
}
for (const meta of actMetas) {
  requests.push({
    method: 'PATCH',
    url: '/api/collections/aw_acts/records/' + meta.recordId,
    body: {
      autoTitle: meta.metadata.title,
      autoSlug: meta.metadata.slug,
      autoSummary: meta.metadata.summary,
      publishKey: meta.metadata.publishKey,
    },
  });
}
for (const meta of eventMetas) {
  requests.push({
    method: 'PATCH',
    url: '/api/collections/aw_events/records/' + meta.recordId,
    body: {
      autoTitle: meta.metadata.title,
      autoSlug: meta.metadata.slug,
      autoSummary: meta.metadata.summary,
      publishKey: meta.metadata.publishKey,
    },
  });
}
requests.push({
  method: 'PATCH',
  url: '/api/collections/aw_tasks/records/' + base.taskRecordId,
  body: {
    autoTitle: taskMeta.metadata.title,
    autoSlug: taskMeta.metadata.slug,
    autoSummary: taskMeta.metadata.summary,
    autoTags: taskMeta.metadata.tags,
    publishKey: taskMeta.metadata.publishKey,
    metadataStatus: 'ready',
    metadataError: '',
  },
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

const verifyMetadataWritesCode = String.raw`
const responses = $input.all();
const isEntryOk = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.error) return false;
  if (Number.isFinite(Number(entry.status))) {
    return Number(entry.status) >= 200 && Number(entry.status) < 300;
  }
  if (entry.body && typeof entry.body === 'object') return !entry.body.error;
  return typeof entry.id === 'string';
};
for (const item of responses) {
  const body = item.json;
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    if (!isEntryOk(entry)) {
      throw new Error('PocketBase metadata batch write failed.');
    }
  }
}
const base = $('Evaluate Job State').first().json;
return {
  json: {
    ownerId: base.ownerId,
    taskRecordId: base.taskRecordId,
    checksum: base.checksum,
    eventId: base.eventId,
    buildMd: base.buildMd,
    buildPdf: base.buildPdf,
    nextVersion: base.nextVersion,
    metadataWritten: true,
  },
};`;

const parsePublishJobCode = String.raw`
const base = $('Evaluate Job State').first().json;
const job = $json;
if (
  !job.id ||
  job.owner !== base.ownerId ||
  job.task !== base.taskRecordId ||
  job.status !== 'queued' ||
  Number(job.version) !== base.nextVersion
) {
  throw new Error('PocketBase returned an invalid publish job.');
}
const bytes = new Uint8Array(32);
if (typeof globalThis.crypto?.getRandomValues === 'function') {
  globalThis.crypto.getRandomValues(bytes);
} else {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}
const publishEventId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
return {
  json: {
    ownerId: base.ownerId,
    taskRecordId: base.taskRecordId,
    publishJobId: job.id,
    publishJob: job,
    publishEventId,
    publishTriggerBody: {
      schemaVersion: 2,
      kind: 'taskPublish',
      eventId: publishEventId,
      ownerId: base.ownerId,
      publishJobId: job.id,
      taskRecordId: base.taskRecordId,
    },
  },
};`;

const publishTriggeredCode = String.raw`
const base = $('Parse Publish Job').first().json;
return {
  json: {
    accepted: true,
    publishJobId: base.publishJobId,
    taskRecordId: base.taskRecordId,
    version: base.publishJob.version,
    triggeredAt: new Date().toISOString(),
  },
};`;

function metadataHttp(name, position) {
  return addHttp(name, {
    method: 'POST',
    url: "={{ ($env.NEW_API_BASE_URL || '').replace(/\\/+$/u, '') + '/v1/chat/completions' }}",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: "={{ 'Bearer ' + $env.NEW_API_API_KEY }}" },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' },
    ] },
    sendBody: true,
    contentType: 'raw',
    rawContentType: 'application/json',
    body: '={{ JSON.stringify($json.newApiRequest) }}',
    options: {
      response: { response: { responseFormat: 'autodetect' } },
      batching: { batch: { batchSize: 5, batchInterval: 500 } },
    },
  }, position);
}

addNode('Webhook', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: 'anyworkflow-task-enrich',
  responseMode: 'onReceived',
  options: {},
}, { typeVersion: 2.1, position: [0, 0], webhookId: 'anyworkflow-task-enrich-v1' });
addCode('Validate Event', validateEventCode, 'runOnceForEachItem', [220, 0]);
addHttp('Get PocketBase Task', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records/' + $json.taskRecordId }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [440, 0]);
addCode('Merge Task', mergeTaskCode, 'runOnceForEachItem', [660, 0]);
addHttp('Get Latest Publish Job', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records?perPage=1&sort=-version&filter=' + encodeURIComponent('task = \"' + $json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [880, 0]);
addCode('Evaluate Job State', evaluateJobStateCode, 'runOnceForEachItem', [1100, 0]);
addIf('Is Duplicate', '={{ $json.duplicate || $json.inProgress }}', 'true', [1320, 0]);
addCode('Duplicate Ignored', "return { json: { accepted: true, duplicate: Boolean($json.duplicate), inProgress: Boolean($json.inProgress), eventId: $json.eventId, taskRecordId: $json.taskRecordId } };", 'runOnceForEachItem', [1540, -200]);
addIf('Needs Enrichment', '={{ $json.metadataReady }}', 'false', [1540, 200]);
addHttp('Lock Metadata', {
  method: 'PATCH',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records/' + $json.taskRecordId }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ metadataStatus: 'processing', metadataError: '' }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [1760, 200]);
addHttp('Get Events', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_events/records?perPage=500&sort=eventIndex&filter=' + encodeURIComponent('task = \"' + $('Evaluate Job State').first().json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [1980, 200]);
addHttp('Get Acts', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_acts/records?perPage=500&sort=actIndex&filter=' + encodeURIComponent('event.task = \"' + $('Evaluate Job State').first().json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [2200, 200]);
addHttp('Get Messages', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_messages/records?perPage=500&filter=' + encodeURIComponent('act.event.task = \"' + $('Evaluate Job State').first().json.taskRecordId + '\"') }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [2420, 200]);
addCode('Build Tree', buildTreeCode, 'runOnceForAllItems', [2640, 200]);
addCode('Prepare Message Requests', prepareMessageRequestsCode, 'runOnceForAllItems', [2860, 200]);
metadataHttp('New API Message Metadata', [3080, 200]);
addCode('Parse Message Metadata', parseMetadataCode('Prepare Message Requests', 'message'), 'runOnceForEachItem', [3300, 200]);
addCode('Aggregate Messages', aggregateMessagesCode, 'runOnceForAllItems', [3520, 200]);
metadataHttp('New API Act Metadata', [3740, 200]);
addCode('Parse Act Metadata', parseMetadataCode('Aggregate Messages', 'act'), 'runOnceForEachItem', [3960, 200]);
addCode('Aggregate Acts', aggregateActsCode, 'runOnceForAllItems', [4180, 200]);
metadataHttp('New API Event Metadata', [4400, 200]);
addCode('Parse Event Metadata', parseMetadataCode('Aggregate Acts', 'event'), 'runOnceForEachItem', [4620, 200]);
addCode('Aggregate Events', aggregateEventsCode, 'runOnceForAllItems', [4840, 200]);
metadataHttp('New API Task Metadata', [5060, 200]);
addCode('Parse Task Metadata', parseMetadataCode('Aggregate Events', 'task'), 'runOnceForEachItem', [5280, 200]);
addCode('Build Metadata Writes', buildMetadataWritesCode, 'runOnceForAllItems', [5500, 200]);
addHttp('Write Metadata', {
  method: 'POST',
  url: '={{ $json.batchUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.batchBody) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [5720, 200]);
addCode('Verify Metadata Writes', verifyMetadataWritesCode, 'runOnceForAllItems', [5940, 200]);
addHttp('Create Publish Job', {
  method: 'POST',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ owner: $json.ownerId, task: $json.taskRecordId, version: $json.nextVersion, buildMd: $json.buildMd, buildPdf: $json.buildPdf, sourceChecksum: $json.checksum, status: 'queued', totalDocuments: 0, completedDocuments: 0 }) }}",
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [6160, 200]);
addCode('Parse Publish Job', parsePublishJobCode, 'runOnceForEachItem', [6380, 200]);
addHttp('Trigger Task Publish', {
  method: 'POST',
  url: "={{ ($env.N8N_WEBHOOK_URL || $env.WEBHOOK_URL || '').replace(/\\/+$/u, '') + '/webhook/anyworkflow-task-publish' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'X-Internal-Key', value: '={{ $env.N8N_DOCUMENT_PUBLISH_SECRET }}' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.publishTriggerBody) }}',
  options: { response: { response: { responseFormat: 'autodetect', fullResponse: true, neverError: true } } },
}, [6600, 200]);
addCode('Publish Triggered', publishTriggeredCode, 'runOnceForAllItems', [6820, 200]);

connect('Webhook', 'Validate Event');
connect('Validate Event', 'Get PocketBase Task');
connect('Get PocketBase Task', 'Merge Task');
connect('Merge Task', 'Get Latest Publish Job');
connect('Get Latest Publish Job', 'Evaluate Job State');
connect('Evaluate Job State', 'Is Duplicate');
connect('Is Duplicate', 'Duplicate Ignored', 0);
connect('Is Duplicate', 'Needs Enrichment', 1);
connect('Needs Enrichment', 'Lock Metadata', 0);
connect('Needs Enrichment', 'Create Publish Job', 1);
connect('Lock Metadata', 'Get Events');
connect('Get Events', 'Get Acts');
connect('Get Acts', 'Get Messages');
connect('Get Messages', 'Build Tree');
connect('Build Tree', 'Prepare Message Requests');
connect('Prepare Message Requests', 'New API Message Metadata');
connect('New API Message Metadata', 'Parse Message Metadata');
connect('Parse Message Metadata', 'Aggregate Messages');
connect('Aggregate Messages', 'New API Act Metadata');
connect('New API Act Metadata', 'Parse Act Metadata');
connect('Parse Act Metadata', 'Aggregate Acts');
connect('Aggregate Acts', 'New API Event Metadata');
connect('New API Event Metadata', 'Parse Event Metadata');
connect('Parse Event Metadata', 'Aggregate Events');
connect('Aggregate Events', 'New API Task Metadata');
connect('New API Task Metadata', 'Parse Task Metadata');
connect('Parse Task Metadata', 'Build Metadata Writes');
connect('Build Metadata Writes', 'Write Metadata');
connect('Write Metadata', 'Verify Metadata Writes');
connect('Verify Metadata Writes', 'Create Publish Job');
connect('Create Publish Job', 'Parse Publish Job');
connect('Parse Publish Job', 'Trigger Task Publish');
connect('Trigger Task Publish', 'Publish Triggered');

const workflow = {
  id: 'task-metadata-enrichment-v1',
  name: 'AnyWorkflow Task Metadata Enrichment',
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
    executionTimeout: 1800,
  },
  versionId: 'task-metadata-workflow-v1',
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(
    new URL('./task-metadata.workflow.json', import.meta.url),
    `${JSON.stringify(workflow, null, 2)}\n`,
    'utf8',
  );
}
