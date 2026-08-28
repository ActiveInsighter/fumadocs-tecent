import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Builds "AnyWorkflow Task Publish Error": the shared error workflow for both
// task workflows. Failures in the metadata workflow mark the task
// metadataStatus=failed; failures around a publish job mark the job failed and
// cascade the failure onto its still-processing documents.

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

const CONTEXT_REF = "$('Extract Failure Context').item.json";

const extractFailureContextCode = String.raw`
const root = $json;
const execution = root.execution || {};
const workflowName = String(
  execution.workflow?.name ?? execution.workflowData?.name ?? '',
);
const isMetadataWorkflow = workflowName.includes('Metadata');
const isPublishWorkflow = workflowName.includes('Document Publish');
const lastError = String(
  execution.error?.message
    || (typeof execution.error?.stack === 'string' ? execution.error.stack.split('\n')[0] : '')
    || 'Workflow execution failed.',
).slice(0, 8192);
const runData = execution.data?.resultData?.runData || {};
const candidates = [];
for (const runs of Object.values(runData)) {
  for (const run of Array.isArray(runs) ? runs : []) {
    const items = run.data?.main?.flat?.() || [];
    for (const item of items) if (item?.json) candidates.push(item.json);
  }
}
const lastWith = (predicate) => [...candidates].reverse().find(predicate) || null;
const jobItem = lastWith((item) => typeof item.publishJobId === 'string' && item.publishJobId.length > 0);
const taskItem = lastWith((item) => typeof item.taskRecordId === 'string' && item.taskRecordId.length > 0);
const publishJobId = jobItem ? jobItem.publishJobId : '';
const taskRecordId = taskItem ? taskItem.taskRecordId : '';
const lockRan = Object.prototype.hasOwnProperty.call(runData, 'Lock Metadata');
// Metadata workflow failures only fail the task while enrichment is actually
// in progress: once a publish job exists the metadata write already succeeded.
const markTask = Boolean(isMetadataWorkflow && taskRecordId && lockRan && !publishJobId);
const markJob = Boolean(publishJobId && (isMetadataWorkflow || isPublishWorkflow));
return {
  json: {
    workflowName,
    publishJobId,
    taskRecordId,
    markTask,
    markJob,
    lastNodeExecuted: execution.lastNodeExecuted || '',
    lastError,
    skipped: !markTask && !markJob,
  },
};`;

const prepareDocumentFailuresCode = String.raw`
const context = ${CONTEXT_REF};
const items = Array.isArray($json.items) ? $json.items : [];
const requests = items
  .filter((record) => typeof record.id === 'string' && record.id.length > 0)
  .map((record) => ({
    method: 'PATCH',
    url: '/api/collections/aw_documents/records/' + record.id,
    body: { status: 'failed', lastError: context.lastError },
  }));
return {
  json: {
    failureCount: requests.length,
    batchUrl: $env.POCKETBASE_URL + '/api/batch',
    batchBody: { requests },
  },
};`;

addNode('Error Trigger', 'n8n-nodes-base.errorTrigger', {}, { typeVersion: 1, position: [0, 0] });
addCode('Extract Failure Context', extractFailureContextCode, 'runOnceForEachItem', [220, 0]);
addBooleanIf('Has Failure To Mark', '={{ $json.markTask || $json.markJob }}', [440, 0]);
addBooleanIf('Is Task Metadata Failure', '={{ $json.markTask }}', [660, 200]);
addHttp('Mark Task Metadata Failed', {
  method: 'PATCH',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_tasks/records/' + ${CONTEXT_REF}.taskRecordId }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: `={{ JSON.stringify({ metadataStatus: 'failed', metadataError: ${CONTEXT_REF}.lastError }) }}`,
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [880, 200]);
addBooleanIf('Has Publish Job', `={{ ${CONTEXT_REF}.markJob }}`, [1100, 0]);
addHttp('Get Publish Job', {
  method: 'GET',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + ${CONTEXT_REF}.publishJobId }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1320, 0]);
addStringIf('Should Mark Job Failed', '={{ $json.status }}', 'notEquals', 'published', [1540, 0]);
addHttp('Mark Publish Job Failed', {
  method: 'PATCH',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_publish_jobs/records/' + ${CONTEXT_REF}.publishJobId }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: `={{ JSON.stringify({ status: 'failed', lastError: ${CONTEXT_REF}.lastError }) }}`,
  options: { response: { response: { responseFormat: 'autodetect' } } },
}, [1760, 0]);
addHttp('List Processing Documents', {
  method: 'GET',
  url: `={{ $env.POCKETBASE_URL + '/api/collections/aw_documents/records?perPage=500&filter=' + encodeURIComponent('publishJob = "' + ${CONTEXT_REF}.publishJobId + '" && status = "processing"') }}`,
  sendHeaders: true,
  headerParameters: pocketBaseHeaders(),
  options: { response: { response: { responseFormat: 'json' } } },
}, [1980, 0]);
addCode('Prepare Document Failures', prepareDocumentFailuresCode, 'runOnceForAllItems', [2200, 0]);
addBooleanIf('Has Document Failures', '={{ $json.failureCount > 0 }}', [2420, 0]);
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
}, [2640, 0]);
addNode('Error Handled', 'n8n-nodes-base.noOp', {}, { typeVersion: 1, position: [2860, 200] });

connect('Error Trigger', 'Extract Failure Context');
connect('Extract Failure Context', 'Has Failure To Mark');
connect('Has Failure To Mark', 'Is Task Metadata Failure', 0);
connect('Is Task Metadata Failure', 'Mark Task Metadata Failed', 0);
connect('Is Task Metadata Failure', 'Has Publish Job', 1);
connect('Mark Task Metadata Failed', 'Has Publish Job');
connect('Has Publish Job', 'Get Publish Job', 0);
connect('Has Publish Job', 'Error Handled', 1);
connect('Get Publish Job', 'Should Mark Job Failed');
connect('Should Mark Job Failed', 'Mark Publish Job Failed', 0);
connect('Should Mark Job Failed', 'Error Handled', 1);
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
  versionId: 'task-publish-error-workflow-v1',
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
