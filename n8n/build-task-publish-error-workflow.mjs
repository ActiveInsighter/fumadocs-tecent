import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Builds "AnyWorkflow Task Publish Error": the shared error workflow for both
// task workflows. The n8n error-trigger payload only carries the failing
// workflow name plus the error itself, so stuck records are located in
// PocketBase within a freshness window: metadata failures fail a task stuck
// in metadataStatus=processing, and any task-workflow failure fails a publish
// job stuck in a non-terminal status and cascades onto its documents.

const nodes = [];
const connections = {};

function addNode(name, type, parameters, extra = {}) {
  const node = {
    parameters,
    id: `task-publish-error-${nodes.length + 1}`,
    name,
    type,
    typeVersion: extra.typeVersion ?? 2,
    position: extra.position ?? [0, nodes.length * 220],
  };
  if (extra.retryOnFail !== undefined) node.retryOnFail = extra.retryOnFail;
  if (extra.maxTries !== undefined) node.maxTries = extra.maxTries;
  if (extra.waitBetweenTries !== undefined) node.waitBetweenTries = extra.waitBetweenTries;
  nodes.push(node);
  return name;
}

function addCode(name, jsCode, mode = 'runOnceForAllItems', position) {
  return addNode(name, 'n8n-nodes-base.code', { mode, jsCode }, { typeVersion: 2, position });
}

function addHttp(name, parameters, position) {
  return addNode(name, 'n8n-nodes-base.httpRequest', parameters, {
    typeVersion: 4.2,
    position,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2_000,
  });
}

function addBooleanIf(name, value, position) {
  return addNode(name, 'n8n-nodes-base.if', {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: `task-publish-error-condition-${nodes.length + 1}`,
          leftValue: value,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
  }, { typeVersion: 2.2, position });
}

function addStringIf(name, leftValue, operation, rightValue, position) {
  return addNode(name, 'n8n-nodes-base.if', {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: `task-publish-error-condition-${nodes.length + 1}`,
          leftValue,
          rightValue,
          operator: { type: 'string', operation, singleValue: true },
        },
      ],
      combinator: 'and',
    },
  }, { typeVersion: 2.2, position });
}

function connect(from, to, output = 0) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}

function pocketBaseHeaders() {
  return { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] };
}

const CONTEXT_REF = "$('Extract Failure Context').first().json";
const TASK_REF = "$('Resolve Stuck Task').first().json";
const JOB_REF = "$('Resolve Stuck Job').first().json";

const extractFailureContextCode = String.raw`
const root = $json;
const execution = root.execution || {};
// n8n 2.x error-trigger payloads keep the workflow at the top level; older
// builds nested it inside execution. Support both shapes.
const workflowName = String(
  root.workflow?.name ?? execution.workflow?.name ?? execution.workflowData?.name ?? '',
);
const isMetadataWorkflow = workflowName.includes('Metadata');
const isPublishWorkflow = workflowName.includes('Document Publish');
const isTaskWorkflow = isMetadataWorkflow || isPublishWorkflow;
const lastNodeExecuted = String(execution.lastNodeExecuted || '');
// Authentication, ownership checks, duplicate exits, and lock attempts happen
// before this execution owns any mutable PocketBase record. Never let a bad
// public webhook request fail an unrelated in-flight task through the
// freshness-window fallback.
const metadataPreflightNodes = new Set([
  'Webhook',
  'Validate Event',
  'Get PocketBase Task',
  'Merge Task',
  'Get Latest Publish Job',
  'Evaluate Job State',
  'Is Duplicate',
  'Duplicate Ignored',
  'Needs Enrichment',
  'Lock Metadata',
]);
const metadataJobNodes = new Set([
  'Create Publish Job',
  'Parse Publish Job',
  'Trigger Task Publish',
  'Publish Triggered',
]);
const publishPreflightNodes = new Set([
  'Webhook',
  'Validate Event',
  'Get Publish Job',
  'Merge Publish Job',
  'Is Job Finished',
  'Publish Already Done',
  'Get Task',
  'Merge Task',
  'Lock Publish Job',
]);
const markTask = Boolean(
  isMetadataWorkflow
  && lastNodeExecuted
  && !metadataPreflightNodes.has(lastNodeExecuted)
  && !metadataJobNodes.has(lastNodeExecuted)
);
const markJob = Boolean(
  (isMetadataWorkflow && metadataJobNodes.has(lastNodeExecuted))
  || (isPublishWorkflow && lastNodeExecuted && !publishPreflightNodes.has(lastNodeExecuted))
);
const shouldHandleFailure = markTask || markJob;
const lastError = String(
  execution.error?.message
    || (typeof execution.error?.stack === 'string' ? execution.error.stack.split('\n')[0] : '')
    || 'Workflow execution failed.',
).slice(0, 8192);
return {
  json: {
    workflowName,
    isMetadataWorkflow,
    isTaskWorkflow,
    markTask,
    markJob,
    shouldHandleFailure,
    lastNodeExecuted,
    lastError,
  },
};`;

const resolveStuckTaskCode = String.raw`
const items = Array.isArray($json.items) ? $json.items : [];
// The fallback has no execution-level record id. Fail closed when concurrent
// candidates make ownership ambiguous instead of modifying the newest record.
const task = items.length === 1 ? items[0] : null;
return {
  json: {
    taskRecordId: task && typeof task.id === 'string' ? task.id : '',
  },
};`;

const resolveStuckJobCode = String.raw`
const items = Array.isArray($json.items) ? $json.items : [];
// See Resolve Stuck Task: automatic recovery is safe only for one candidate.
const job = items.length === 1 ? items[0] : null;
return {
  json: {
    publishJobId: job && typeof job.id === 'string' ? job.id : '',
    taskRecordId: job && typeof job.task === 'string' ? job.task : '',
  },
};`;

const prepareDocumentFailuresCode = String.raw`
const context = ${CONTEXT_REF};
const job = ${JOB_REF};
const items = Array.isArray($json.items) ? $json.items : [];
const requests = items
  .filter((record) => typeof record.id === 'string' && record.id.length > 0)
  .map((record) => ({
    method: 'PATCH',
    url: '/api/collections/aw_documents/records/' + record.id,
    body: { status: 'failed', lastError: context.lastError },
  }));
const chunks = [];
for (let index = 0; index < requests.length; index += 50) {
  chunks.push(requests.slice(index, index + 50));
}
if (chunks.length === 0) chunks.push([]);
return chunks.map((chunk) => ({
  json: {
    failureCount: chunk.length,
    publishJobId: job.publishJobId,
    batchUrl: $env.POCKETBASE_URL + '/api/batch',
    batchBody: { requests: chunk },
  },
}));`;

addNode('Error Trigger', 'n8n-nodes-base.errorTrigger', {}, { typeVersion: 1, position: [0, 0] });
addCode('Extract Failure Context', extractFailureContextCode, 'runOnceForEachItem', [220, 0]);
addBooleanIf('Has Failure To Handle', '={{ $json.shouldHandleFailure }}', [440, 0]);
addBooleanIf('Should Mark Task Metadata Failed', `={{ ${CONTEXT_REF}.markTask }}`, [660, -140]);

addHttp('Find Stuck Task', {
  method: 'GET',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records?perPage=2&sort=-updated&fields=id,title&filter=' + encodeURIComponent("metadataStatus = 'processing' && updated > '" + $now.minus(60, 'minutes').toUTC().toFormat('yyyy-MM-dd HH:mm:ss') + "'") }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [880, -140]);
addCode('Resolve Stuck Task', resolveStuckTaskCode, 'runOnceForAllItems', [1100, -140]);
addStringIf('Has Stuck Task', `={{ $json.taskRecordId }}`, 'notEmpty', '', [1320, -140]);
addHttp('Mark Task Metadata Failed', {
  method: 'PATCH',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records/' + ${TASK_REF}.taskRecordId }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: `={{ JSON.stringify({ metadataStatus: 'failed', metadataError: ${CONTEXT_REF}.lastError }) }}`,
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [1540, -140]);

addBooleanIf('Should Mark Publish Job Failed', `={{ ${CONTEXT_REF}.markJob }}`, [1760, 0]);

addHttp('Find Stuck Publish Job', {
  method: 'GET',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records?perPage=2&sort=-updated&fields=id,task,status&filter=' + encodeURIComponent("status != 'published' && status != 'failed' && updated > '" + $now.minus(60, 'minutes').toUTC().toFormat('yyyy-MM-dd HH:mm:ss') + "'") }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1980, 0]);
addCode('Resolve Stuck Job', resolveStuckJobCode, 'runOnceForAllItems', [2200, 0]);
addStringIf('Has Stuck Job', `={{ $json.publishJobId }}`, 'notEmpty', '', [2420, 0]);
addHttp('Mark Publish Job Failed', {
  method: 'PATCH',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + ${JOB_REF}.publishJobId }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: `={{ JSON.stringify({ status: 'failed', lastError: ${CONTEXT_REF}.lastError }) }}`,
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [2640, 0]);
addHttp('List Processing Documents', {
  method: 'GET',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_documents/records?perPage=500&filter=' + encodeURIComponent('publishJob = "' + ${JOB_REF}.publishJobId + '" && status = "processing"') }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [2860, 0]);
addCode('Prepare Document Failures', prepareDocumentFailuresCode, 'runOnceForAllItems', [3080, 0]);
addBooleanIf('Has Document Failures', '={{ $json.failureCount > 0 }}', [3300, 0]);
addHttp('Write Document Failures', {
  method: 'POST',
  url: '={{ $json.batchUrl }}',
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.batchBody) }}',
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [3520, 0]);
addNode('Error Handled', 'n8n-nodes-base.noOp', {}, { typeVersion: 1, position: [3740, 0] });

connect('Error Trigger', 'Extract Failure Context');
connect('Extract Failure Context', 'Has Failure To Handle');
connect('Has Failure To Handle', 'Should Mark Task Metadata Failed', 0);
connect('Has Failure To Handle', 'Error Handled', 1);
connect('Should Mark Task Metadata Failed', 'Find Stuck Task', 0);
connect('Should Mark Task Metadata Failed', 'Should Mark Publish Job Failed', 1);
connect('Find Stuck Task', 'Resolve Stuck Task');
connect('Resolve Stuck Task', 'Has Stuck Task');
connect('Has Stuck Task', 'Mark Task Metadata Failed', 0);
connect('Has Stuck Task', 'Should Mark Publish Job Failed', 1);
connect('Mark Task Metadata Failed', 'Should Mark Publish Job Failed');
connect('Should Mark Publish Job Failed', 'Find Stuck Publish Job', 0);
connect('Should Mark Publish Job Failed', 'Error Handled', 1);
connect('Find Stuck Publish Job', 'Resolve Stuck Job');
connect('Resolve Stuck Job', 'Has Stuck Job');
connect('Has Stuck Job', 'Mark Publish Job Failed', 0);
connect('Has Stuck Job', 'Error Handled', 1);
connect('Mark Publish Job Failed', 'List Processing Documents');
connect('List Processing Documents', 'Prepare Document Failures');
connect('Prepare Document Failures', 'Has Document Failures');
connect('Has Document Failures', 'Write Document Failures', 0);
connect('Has Document Failures', 'Error Handled', 1);
connect('Write Document Failures', 'Error Handled');

const workflow = {
  id: 'task-publish-error-v1',
  name: 'AnyWorkflow Task Publish Error',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
  },
  versionId: 'task-publish-error-workflow-v2',
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(
    new URL('./task-publish-error.workflow.json', import.meta.url),
    `${JSON.stringify(workflow, null, 2)}\n`,
    'utf8',
  );
}
