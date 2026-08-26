import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const nodes = [];
const connections = {};

function addNode(name, type, parameters, extra = {}) {
  const node = {
    parameters,
    id: `document-publish-${nodes.length + 1}`,
    name,
    type,
    typeVersion: extra.typeVersion ?? 2,
    position: extra.position ?? [0, nodes.length * 220],
    ...extra,
  };
  delete node.typeVersion;
  node.typeVersion = extra.typeVersion ?? 2;
  delete node.position;
  node.position = extra.position ?? [0, nodes.length * 220];
  delete node.retryOnFail;
  if (extra.retryOnFail !== undefined) node.retryOnFail = extra.retryOnFail;
  if (extra.maxTries !== undefined) node.maxTries = extra.maxTries;
  if (extra.waitBetweenTries !== undefined) node.waitBetweenTries = extra.waitBetweenTries;
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

function connect(from, to, output = 0, input = 0) {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
}

const validateEventCode = String.raw`
const input = $input.first().json;
const body = input.body && typeof input.body === 'object' ? input.body : input;
const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
const receivedSecret = headers['x-internal-key'] || headers['X-Internal-Key'];
const expectedSecret = $env.N8N_DOCUMENT_PUBLISH_SECRET;
if (typeof expectedSecret !== 'string' || expectedSecret.length < 16 || receivedSecret !== expectedSecret) {
  throw new Error('Document publish webhook authentication failed.');
}
if (
  body.schemaVersion !== 1 ||
  body.kind !== 'message' ||
  typeof body.eventId !== 'string' ||
  !/^[a-f0-9]{64}$/.test(body.eventId) ||
  typeof body.ownerId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.ownerId) ||
  typeof body.messageRecordId !== 'string' ||
  !/^[a-z0-9]{15}$/.test(body.messageRecordId) ||
  typeof body.entryKey !== 'string' ||
  body.entryKey.length < 1 ||
  body.entryKey.length > 512 ||
  typeof body.checksum !== 'string' ||
  !/^[a-f0-9]{64}$/.test(body.checksum)
) {
  throw new Error('Document publish webhook payload is invalid.');
}
return {
  json: {
    eventId: body.eventId,
    ownerId: body.ownerId,
    messageRecordId: body.messageRecordId,
    entryKey: body.entryKey,
    checksum: body.checksum,
    source: 'anyworkflow',
  },
};`;

const mergeMessageCode = String.raw`
const event = $('Validate Event').item.json;
const message = $input.first().json;
if (
  message.id !== event.messageRecordId ||
  message.owner !== event.ownerId ||
  typeof message.userMarkdown !== 'string' ||
  typeof message.assistantMarkdown !== 'string' ||
  message.assistantMarkdown.trim().length === 0
) {
  throw new Error('PocketBase returned an invalid or cross-owner message.');
}
return {
  json: {
    ...event,
    message,
    assistantMarkdown: message.assistantMarkdown,
    userMarkdown: message.userMarkdown,
  },
};`;

const documentLookupCode = String.raw`
const base = $input.first().json;
const filter = 'owner = "' + base.ownerId + '" && documentId = "' + base.messageRecordId + '"';
return {
  json: {
    ...base,
    documentLookupUrl: $env.POCKETBASE_URL + '/api/collections/aw_documents/records?perPage=2&filter=' + encodeURIComponent(filter),
  },
};`;

const documentStateCode = String.raw`
const base = $('Merge Message').item.json;
const result = $input.first().json;
const records = Array.isArray(result.items) ? result.items : [];
if (records.length > 1) throw new Error('PocketBase returned duplicate document identities.');
const existing = records[0];
const sameSource = existing && existing.sourceChecksum === base.checksum;
const inProgress = Boolean(sameSource && existing.status === 'processing');
const duplicate = Boolean(sameSource && ['processing', 'published'].includes(existing.status));
const version = sameSource
  ? Math.max(1, Number(existing.version) || 1)
  : Math.max(1, Number(existing?.version) || 0) + (existing ? 1 : 0);
return {
  json: {
    ...base,
    documentId: base.messageRecordId,
    documentRecordId: existing?.id,
    existingDocument: existing || null,
    documentVersion: version,
    inProgress,
    duplicate,
  },
};`;

const metadataRequestCode = String.raw`
const base = $input.first().json;
const system = 'You normalize an AI answer into document metadata. Return only JSON with title, slug, summary, and tags. title is a concise human title; slug uses lowercase ASCII letters, numbers, and hyphens only; summary is at most 300 Chinese characters; tags is an array of at most 8 short strings. Do not invent technical claims.';
const user = 'Original user request:\n' + base.userMarkdown + '\n\nAssistant answer:\n' + base.assistantMarkdown;
return {
  json: {
    ...base,
    newApiRequest: {
      model: $env.NEW_API_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  },
};`;

const metadataParseCode = String.raw`
const base = $('Prepare Metadata Request').item.json;
const response = $input.first().json;
let raw = response?.choices?.[0]?.message?.content;
if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('New API returned no metadata.');
const fence = String.fromCharCode(96).repeat(3);
raw = raw.trim().replace(new RegExp('^' + fence + '(?:json)?\\s*', 'iu'), '').replace(new RegExp('\\s*' + fence + '$', 'u'), '');
let metadata;
try {
  metadata = JSON.parse(raw);
} catch {
  throw new Error('New API metadata was not valid JSON.');
}
const heading = base.assistantMarkdown.match(/^#\s+(.+)$/mu)?.[1]?.trim();
const title = typeof metadata.title === 'string' && metadata.title.trim().length > 0
  ? metadata.title.trim().slice(0, 512)
  : (heading || 'AI Document').slice(0, 512);
const fallbackSlug = 'document';
const candidateSlug = typeof metadata.slug === 'string' ? metadata.slug.trim().toLowerCase() : '';
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidateSlug) && candidateSlug.length <= 96
  ? candidateSlug
  : fallbackSlug;
const summary = typeof metadata.summary === 'string' ? metadata.summary.trim().slice(0, 2000) : '';
const tags = Array.isArray(metadata.tags)
  ? metadata.tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 8)
  : [];
return {
  json: {
    ...base,
    metadata: { title, slug, summary, tags },
  },
};`;

const buildDocumentCode = String.raw`
const base = $('Parse Metadata').item.json;
function cleanMarkdown(input) {
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
  const withTitle = /^#\s+/mu.test(cleaned)
    ? cleaned
    : '# ' + base.metadata.title + '\n\n' + cleaned;
  if (new TextEncoder().encode(withTitle).byteLength > 1_048_576) {
    throw new Error('The cleaned Markdown exceeds the PocketBase document limit.');
  }
  return withTitle + '\n';
}
const markdown = cleanMarkdown(base.assistantMarkdown);
const pageSlug = base.metadata.slug + '-' + base.documentId.slice(-8);
const frontmatter = '---\n'
  + 'title: ' + JSON.stringify(base.metadata.title) + '\n'
  + 'description: ' + JSON.stringify(base.metadata.summary || base.metadata.title) + '\n'
  + 'documentId: ' + JSON.stringify(base.documentId) + '\n'
  + 'documentVersion: ' + base.documentVersion + '\n'
  + '---\n\n';
const mdx = frontmatter + markdown;
const fumadocsPath = 'content/docs/' + pageSlug + '.mdx';
return {
  json: {
    ...base,
    markdown,
    mdx,
    fumadocsPath,
    documentBody: {
      owner: base.ownerId,
      sourceMessage: base.messageRecordId,
      documentId: base.documentId,
      slug: pageSlug,
      title: base.metadata.title,
      summary: base.metadata.summary,
      tags: base.metadata.tags,
      status: 'processing',
      version: base.documentVersion,
      sourceChecksum: base.checksum,
      fumadocsPath,
      lastError: '',
    },
  },
};`;

const mdToPdfInputCode = String.raw`
const base = $input.first().json;
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
let parsedUrl;
try {
  parsedUrl = new URL(supabaseUrl);
} catch {
  throw new Error('mdTOpdf Supabase URL configuration is invalid.');
}
if (
  parsedUrl.protocol !== 'https:'
  || parsedUrl.username
  || parsedUrl.password
  || parsedUrl.search
  || parsedUrl.hash
  || !serviceKey
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId)
  || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(bucket)
  || !new Set(['chatgpt-light', 'academic', 'github']).has(theme)
) {
  throw new Error('mdTOpdf Supabase integration configuration is invalid.');
}
const sourceCandidate = typeof base.fumadocsPath === 'string'
  ? base.fumadocsPath.split('/').pop()?.replace(/\.mdx$/iu, '.md')
  : '';
const sourceFilename = typeof sourceCandidate === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,170}\.md$/u.test(sourceCandidate)
  ? sourceCandidate
  : 'document-' + base.documentId.slice(-8) + '.md';
const documentName = sourceFilename.slice(0, -3).slice(0, 160) || 'document';
const randomUuid = globalThis.crypto?.randomUUID;
if (typeof randomUuid !== 'function') throw new Error('The n8n runtime does not provide crypto.randomUUID.');
const jobId = randomUuid.call(globalThis.crypto);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(jobId)) {
  throw new Error('mdTOpdf generated an invalid job ID.');
}
const inputPath = 'jobs/' + jobId + '/input.md';
const outputPath = 'jobs/' + jobId + '/output.pdf';
const encodePath = (value) => value.split('/').map((part) => encodeURIComponent(part)).join('/');
const encodedInputPath = encodePath(inputPath);
const encodedOutputPath = encodePath(outputPath);
const repoBase = 'https://api.github.com/repos/ActiveInsighter/md-to-pdf';
return {
  json: {
    ...base,
    mdToPdfSupabaseUrl: supabaseUrl,
    mdToPdfSupabaseBucket: bucket,
    mdToPdfJobId: jobId,
    mdToPdfInputPath: inputPath,
    mdToPdfOutputPath: outputPath,
    mdToPdfSourceFilename: sourceFilename,
    mdToPdfJobInsertUrl: supabaseUrl + '/rest/v1/pdf_jobs',
    mdToPdfJobUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + jobId,
    mdToPdfJobStatusUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + jobId
      + '&select=id,status,output_path,error_message,github_run_id',
    mdToPdfMarkUploadedUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + jobId + '&status=eq.created',
    mdToPdfQueueUrl: supabaseUrl + '/rest/v1/pdf_jobs?id=eq.' + jobId + '&status=eq.uploaded',
    mdToPdfUploadUrl: supabaseUrl + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodedInputPath,
    mdToPdfOutputDownloadUrl: supabaseUrl + '/storage/v1/object/authenticated/'
      + encodeURIComponent(bucket) + '/' + encodedOutputPath,
    mdToPdfDispatchUrl: repoBase + '/actions/workflows/build-pdf-api.yml/dispatches',
    mdToPdfWorkflowFile: 'build-pdf-api.yml',
    mdToPdfWorkflowRef: 'main',
    mdToPdfWorkflowEvent: 'workflow_dispatch',
    mdToPdfJobBody: {
      id: jobId,
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
  },
};`;

const mdToPdfJobResponseCode = String.raw`
const base = $('Prepare mdTOpdf Input').item.json;
const response = $input.first().json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf job creation failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
const job = rows[0];
if (!job || job.id !== base.mdToPdfJobId || job.status !== 'created' || job.input_path !== base.mdToPdfInputPath) {
  throw new Error('mdTOpdf returned an invalid created job.');
}
return {
  json: { ...base, mdToPdfJobRecord: job },
};`;

const mdToPdfUploadResponseCode = String.raw`
const base = $('Parse mdTOpdf Job').item.json;
const response = $input.first().json;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf Markdown upload failed with status ' + statusCode + '.');
}
return { json: base };`;

const mdToPdfUploadedResponseCode = String.raw`
const base = $('Parse mdTOpdf Upload').item.json;
const response = $input.first().json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf uploaded-state update failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
if (rows.length > 0 && rows[0].status !== 'uploaded') {
  throw new Error('mdTOpdf did not enter the uploaded state.');
}
return { json: { ...base, mdToPdfUploaded: true } };`;

const mdToPdfQueuedResponseCode = String.raw`
const base = $('Parse mdTOpdf Uploaded').item.json;
const response = $input.first().json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 201) {
  throw new Error('mdTOpdf queue update failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
if (rows.length > 0 && rows[0].status !== 'queued') {
  throw new Error('mdTOpdf did not enter the queued state.');
}
return { json: { ...base, mdToPdfQueued: true } };`;

const mdToPdfDispatchRequestCode = String.raw`
const base = $('Parse mdTOpdf Queued').item.json;
return {
  json: {
    ...base,
    mdToPdfDispatchedAt: new Date().toISOString(),
    mdToPdfPollCount: 0,
    mdToPdfDispatchPayload: {
      ref: base.mdToPdfWorkflowRef,
      inputs: { job_id: base.mdToPdfJobId },
    },
  },
};`;

const mdToPdfDispatchResponseCode = String.raw`
const base = $('Prepare mdTOpdf Dispatch').item.json;
const response = $input.first().json;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 204) {
  throw new Error('mdTOpdf workflow dispatch failed with status ' + statusCode + '.');
}
return { json: { ...base, mdToPdfPollCount: 0 } };`;

const mdToPdfJobStatusCode = String.raw`
const input = $input.first().json;
const base = input?.mdToPdfJobId
  ? input
  : $('Wait mdTOpdf Action').item.json;
const response = input?.mdTOpdfResponse && typeof input.mdTOpdfResponse === 'object'
  ? input.mdTOpdfResponse
  : input;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
  throw new Error('mdTOpdf job status lookup failed with status ' + statusCode + '.');
}
const rows = Array.isArray(body) ? body : [body];
const job = rows[0];
if (!job || job.id !== base.mdToPdfJobId || typeof job.status !== 'string') {
  throw new Error('mdTOpdf returned an invalid job status response.');
}
const pollCount = Number(base.mdToPdfPollCount || 0) + 1;
const dispatchedAt = Date.parse(base.mdToPdfDispatchedAt);
if (!Number.isFinite(dispatchedAt) || pollCount > 165 || Date.now() - dispatchedAt > 27 * 60 * 1000) {
  throw new Error('Timed out waiting for the mdTOpdf GitHub Action job.');
}
if (job.status === 'failed') {
  throw new Error('mdTOpdf GitHub Action failed: ' + String(job.error_message || 'unknown error').slice(0, 500));
}
if (!new Set(['queued', 'building', 'uploading', 'completed']).has(job.status)) {
  throw new Error('mdTOpdf returned an unexpected job status: ' + job.status);
}
if (job.status === 'completed' && job.output_path !== base.mdToPdfOutputPath) {
  throw new Error('mdTOpdf completed without the expected output path.');
}
return {
  json: {
    ...base,
    mdToPdfPollCount: pollCount,
    mdToPdfStatus: job.status,
    mdToPdfReady: job.status === 'completed',
  },
};`;

const mdToPdfPdfSelectionCode = String.raw`
const input = $input.first();
const base = input?.json?.mdToPdfJobId
  ? input.json
  : $('Parse mdTOpdf Job Status').item.json;
const pdf = input.binary?.data;
if (!pdf) throw new Error('mdTOpdf returned no PDF binary.');
const looksLikePdf = pdf.mimeType === 'application/pdf'
  || pdf.fileExtension?.toLowerCase() === 'pdf'
  || pdf.fileName?.toLowerCase().endsWith('.pdf');
if (!looksLikePdf && !pdf.data) throw new Error('mdTOpdf returned an invalid PDF binary.');
const fileName = base.fumadocsPath.split('/').pop()?.replace(/\.mdx$/iu, '.pdf') || 'document.pdf';
return {
  json: { ...base, mdToPdfPdfFileName: fileName },
  binary: {
    data: {
      ...pdf,
      fileName,
      fileExtension: 'pdf',
      mimeType: 'application/pdf',
    },
  },
};`;

const mergePdfCode = String.raw`
const base = $('Merge Document Response').item.json;
const item = $input.first();
if (!item.binary?.data) throw new Error('mdTOpdf did not return a PDF binary.');
return {
  json: { ...base },
  binary: item.binary,
};`;

const documentWriteCode = String.raw`
const base = $('Build Document').item.json;
const path = base.documentRecordId
  ? '/api/collections/aw_documents/records/' + base.documentRecordId
  : '/api/collections/aw_documents/records';
return {
  json: {
    ...base,
    documentWriteMethod: base.documentRecordId ? 'PATCH' : 'POST',
    documentWriteUrl: $env.POCKETBASE_URL + path,
  },
};`;

const mergeDocumentCode = String.raw`
const base = $('Prepare Document Write').item.json;
const record = $input.first().json;
if (!record.id || record.owner !== base.ownerId) throw new Error('PocketBase document write returned an invalid record.');
return {
  json: { ...base, documentRecord: record },
  binary: $('Prepare Document Write').item.binary,
};`;

const artifactItemsCode = String.raw`
const base = $input.first();
const common = {
  ...base.json,
  artifactReference: {
    documentId: base.json.documentId,
    version: base.json.documentVersion,
  },
};
return [
  {
    json: {
      ...common,
      artifact: { format: 'md', contentType: 'text/markdown', body: base.json.markdown },
      artifactReference: { ...common.artifactReference, format: 'md' },
    },
  },
  {
    json: {
      ...common,
      artifact: { format: 'pdf', contentType: 'application/pdf' },
      artifactReference: { ...common.artifactReference, format: 'pdf' },
    },
    binary: base.binary,
  },
];`;

const mergeSignerCode = String.raw`
const source = $('Create Artifact Items').item;
const signer = $input.first().json;
if (
  signer.key !== 'documents/' + source.json.documentId + '/v' + source.json.documentVersion + '/document.' + source.json.artifact.format ||
  typeof signer.uploadUrl !== 'string' ||
  signer.contentType !== source.json.artifact.contentType
) throw new Error('Fumadocs returned an invalid Blob upload signer response.');
return {
  json: { ...source.json, signer },
  binary: source.binary,
};`;

const prepareMarkdownArtifactCode = String.raw`
const base = $('Merge Signer Response').item.json;
const body = base.artifact.body;
return {
  json: {
    ...base,
    artifactBody: {
      owner: base.ownerId,
      document: base.documentRecord.id,
      version: base.documentVersion,
      format: 'md',
      blobKey: base.signer.key,
      contentType: 'text/markdown',
      byteSize: new TextEncoder().encode(body).byteLength,
      checksum: base.checksum,
      status: 'uploaded',
      downloadPath: '/download/' + base.documentId + '/' + base.documentVersion + '/md',
    },
  },
};`;

const preparePdfArtifactCode = String.raw`
const base = $('Merge Signer Response').item;
const binary = base.binary?.data;
if (!binary) throw new Error('The PDF binary was lost before artifact persistence.');
const byteSize = Number.isSafeInteger(Number(binary.fileSize)) && Number(binary.fileSize) > 0
  ? Number(binary.fileSize)
  : (typeof binary.data === 'string' ? Buffer.from(binary.data, 'base64').byteLength : 0);
if (byteSize < 1) throw new Error('The PDF binary has no measurable content.');
return {
  json: {
    ...base.json,
    artifactBody: {
      owner: base.json.ownerId,
      document: base.json.documentRecord.id,
      version: base.json.documentVersion,
      format: 'pdf',
      blobKey: base.json.signer.key,
      contentType: 'application/pdf',
       byteSize,
      checksum: base.json.checksum,
      status: 'uploaded',
      downloadPath: '/download/' + base.json.documentId + '/' + base.json.documentVersion + '/pdf',
    },
  },
  binary: base.binary,
};`;

const mergeArtifactLookupCode = String.raw`
const base = $('Merge Artifact Uploads').item.json;
const result = $input.first().json;
const records = Array.isArray(result.items) ? result.items : [];
if (records.length > 1) throw new Error('PocketBase returned duplicate artifact identities.');
const existing = records[0];
return {
  json: {
    ...base,
    existingArtifactId: existing?.id,
    artifactWriteMethod: existing?.id ? 'PATCH' : 'POST',
    artifactWriteUrl: $env.POCKETBASE_URL + (existing?.id
      ? '/api/collections/aw_document_artifacts/records/' + existing.id
      : '/api/collections/aw_document_artifacts/records'),
  },
  binary: $('Merge Artifact Uploads').item.binary,
};`;

const artifactLookupCode = String.raw`
const base = $('Merge Artifact Uploads').item.json;
const filter = 'document = "' + base.documentRecord.id + '" && version = ' + base.documentVersion + ' && format = "' + base.artifact.format + '"';
return {
  json: {
    ...base,
    artifactLookupUrl: $env.POCKETBASE_URL + '/api/collections/aw_document_artifacts/records?perPage=2&filter=' + encodeURIComponent(filter),
  },
  binary: $('Merge Artifact Uploads').item.binary,
};`;

const aggregateArtifactsCode = String.raw`
const source = $('Merge Artifact Lookup').all();
const responses = $input.all();
if (source.length !== 2 || responses.length !== 2) throw new Error('Both document artifacts are required before publishing.');
const artifactRecords = source.map((item, index) => {
  const record = responses[index].json;
  if (!record.id) throw new Error('PocketBase artifact write returned an invalid record.');
  return { id: record.id, format: item.json.artifact.format, body: item.json.artifactBody };
});
const base = $('Merge Document Response').first().json;
return {
  json: { ...base, artifactRecords },
};`;

const githubLookupCode = String.raw`
const base = $input.first().json;
const encodedPath = base.fumadocsPath.split('/').map((part) => encodeURIComponent(part)).join('/');
return {
  json: {
    ...base,
    githubBranch: $env.GITHUB_BRANCH || 'main',
    githubUrl: 'https://api.github.com/repos/' + $env.GITHUB_OWNER + '/' + $env.GITHUB_REPO + '/contents/' + encodedPath,
  },
};`;

const githubResponseCode = String.raw`
const base = $('Prepare GitHub Lookup').item.json;
const response = $input.first().json;
const body = response.body && typeof response.body === 'object' ? response.body : response;
const statusCode = Number(response.statusCode);
if (Number.isFinite(statusCode) && statusCode !== 200 && statusCode !== 404) {
  throw new Error('GitHub file lookup failed with status ' + statusCode + '.');
}
if (Number.isFinite(statusCode) && statusCode === 200 && typeof body.sha !== 'string') {
  throw new Error('GitHub file lookup returned no file SHA.');
}
if (!Number.isFinite(statusCode) && body.message && typeof body.message === 'string') {
  throw new Error('GitHub file lookup failed.');
}
return {
  json: {
    ...base,
    githubSha: typeof body.sha === 'string' ? body.sha : undefined,
  },
};`;

const githubRequestCode = String.raw`
const base = $('Parse GitHub File').item.json;
const payload = {
  message: 'docs: publish ' + base.metadata.slug,
  content: Buffer.from(base.mdx, 'utf8').toString('base64'),
  branch: base.githubBranch,
};
if (base.githubSha) payload.sha = base.githubSha;
return {
  json: { ...base, githubPayload: payload },
};`;

const finalizationCode = String.raw`
const base = $('Build GitHub Request').item.json;
const publishedAt = new Date().toISOString();
const items = [
  {
    json: {
      finalizationUrl: $env.POCKETBASE_URL + '/api/collections/aw_documents/records/' + base.documentRecord.id,
      finalizationBody: {
        ...base.documentBody,
        status: 'published',
        publishedAt,
        lastError: '',
      },
    },
  },
];
for (const artifact of base.artifactRecords) {
  items.push({
    json: {
      finalizationUrl: $env.POCKETBASE_URL + '/api/collections/aw_document_artifacts/records/' + artifact.id,
      finalizationBody: { status: 'published' },
    },
  });
}
return items;`;

addNode('Webhook', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: 'anyworkflow-document-publish',
  responseMode: 'onReceived',
  options: {},
}, { typeVersion: 2.1, position: [0, 0], webhookId: 'anyworkflow-document-publish-v1' });
addCode('Validate Event', validateEventCode, 'runOnceForEachItem', [220, 0]);
addHttp('Get PocketBase Message', {
  method: 'GET',
  url: "={{ $env.POCKETBASE_URL + '/api/collections/aw_messages/records/' + $json.messageRecordId + '?expand=act.event.task' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [440, 0]);
addCode('Merge Message', mergeMessageCode, 'runOnceForEachItem', [660, 0]);
addCode('Prepare Document Lookup', documentLookupCode, 'runOnceForEachItem', [880, 0]);
addHttp('Get Existing Document', {
  method: 'GET',
  url: '={{ $json.documentLookupUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [1100, 0]);
addCode('Prepare Document State', documentStateCode, 'runOnceForEachItem', [1320, 0]);
addNode('Is Duplicate', 'n8n-nodes-base.if', {
  conditions: { boolean: [{ value1: '={{ $json.duplicate }}', operation: 'isTrue' }] },
}, { typeVersion: 2.2, position: [1540, 0] });
addCode('Duplicate Ignored', "return { json: { accepted: true, duplicate: true, inProgress: Boolean($json.inProgress), eventId: $json.eventId } };", 'runOnceForEachItem', [1760, -180]);
addCode('Prepare Metadata Request', metadataRequestCode, 'runOnceForEachItem', [1760, 180]);
addHttp('New API Metadata', {
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
  options: { response: { response: { responseFormat: 'json' } } },
}, [1980, 180]);
addCode('Parse Metadata', metadataParseCode, 'runOnceForEachItem', [2200, 180]);
addCode('Build Document', buildDocumentCode, 'runOnceForEachItem', [2420, 180]);
addCode('Prepare Document Write', documentWriteCode, 'runOnceForEachItem', [2640, 180]);
addHttp('Write Document', {
  method: '={{ $json.documentWriteMethod }}',
  url: '={{ $json.documentWriteUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.documentBody) }}',
  options: { response: { response: { responseFormat: 'json' } } },
}, [2860, 180]);
addCode('Merge Document Response', mergeDocumentCode, 'runOnceForEachItem', [3080, 180]);
addCode('Prepare mdTOpdf Input', mdToPdfInputCode, 'runOnceForEachItem', [3300, 180]);
addHttp('Create mdTOpdf Job', {
  method: 'POST',
  url: '={{ $json.mdToPdfJobInsertUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
    { name: 'Prefer', value: 'return=representation' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.mdToPdfJobBody) }}',
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [3520, 180]);
addCode('Parse mdTOpdf Job', mdToPdfJobResponseCode, 'runOnceForEachItem', [3740, 180]);
addHttp('Upload mdTOpdf Markdown', {
  method: 'POST',
  url: '={{ $json.mdToPdfUploadUrl }}',
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
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [3960, 180]);
addCode('Parse mdTOpdf Upload', mdToPdfUploadResponseCode, 'runOnceForEachItem', [4180, 180]);
addHttp('Mark mdTOpdf Uploaded', {
  method: 'PATCH',
  url: '={{ $json.mdToPdfMarkUploadedUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
    { name: 'Prefer', value: 'return=representation' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'uploaded' }) }}",
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [4400, 180]);
addCode('Parse mdTOpdf Uploaded', mdToPdfUploadedResponseCode, 'runOnceForEachItem', [4620, 180]);
addHttp('Queue mdTOpdf Job', {
  method: 'PATCH',
  url: '={{ $json.mdToPdfQueueUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
    { name: 'Prefer', value: 'return=representation' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: "={{ JSON.stringify({ status: 'queued' }) }}",
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [4840, 180]);
addCode('Parse mdTOpdf Queued', mdToPdfQueuedResponseCode, 'runOnceForEachItem', [5060, 180]);
addCode('Prepare mdTOpdf Dispatch', mdToPdfDispatchRequestCode, 'runOnceForEachItem', [5280, 180]);
addHttp('Dispatch mdTOpdf Action', {
  method: 'POST',
  url: '={{ $json.mdToPdfDispatchUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.GITHUB_TOKEN }}" },
    { name: 'Accept', value: 'application/vnd.github+json' },
    { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
    { name: 'Content-Type', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.mdToPdfDispatchPayload) }}',
  options: { response: { response: { responseFormat: 'text', fullResponse: true, neverError: true } } },
}, [5500, 180]);
addCode('Parse mdTOpdf Dispatch', mdToPdfDispatchResponseCode, 'runOnceForEachItem', [5720, 180]);
addNode('Wait mdTOpdf Action', 'n8n-nodes-base.wait', {
  resume: 'timeInterval',
  amount: 10,
  unit: 'seconds',
}, { typeVersion: 1.1, position: [5940, 180] });
addHttp('Get mdTOpdf Job', {
  method: 'GET',
  url: '={{ $json.mdToPdfJobStatusUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [6160, 180]);
addCode('Parse mdTOpdf Job Status', mdToPdfJobStatusCode, 'runOnceForEachItem', [6380, 180]);
addNode('Is mdTOpdf Ready', 'n8n-nodes-base.if', {
  conditions: { boolean: [{ value1: '={{ $json.mdToPdfReady }}', operation: 'isTrue' }] },
}, { typeVersion: 2.2, position: [6600, 180] });
addHttp('Download mdTOpdf PDF', {
  method: 'GET',
  url: '={{ $json.mdToPdfOutputDownloadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'apikey', value: '={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}' },
    { name: 'Authorization', value: "={{ $env.MDTO_PDF_SUPABASE_SERVICE_KEY.startsWith('sb_secret_') ? '' : 'Bearer ' + $env.MDTO_PDF_SUPABASE_SERVICE_KEY }}" },
    { name: 'Accept', value: 'application/pdf' },
  ] },
  responseFormat: 'file',
  outputPropertyName: 'data',
  options: { response: { response: { responseFormat: 'file' } } },
}, [6820, 0]);
addCode('Select mdTOpdf PDF', mdToPdfPdfSelectionCode, 'runOnceForEachItem', [7040, 0]);
addCode('Merge PDF', mergePdfCode, 'runOnceForEachItem', [7260, 180]);
addCode('Create Artifact Items', artifactItemsCode, 'runOnceForAllItems', [7480, 180]);
addHttp('Sign Artifact Upload', {
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
  body: '={{ JSON.stringify($json.artifactReference) }}',
  options: { response: { response: { responseFormat: 'json' } } },
}, [3960, 180]);
addCode('Merge Signer Response', mergeSignerCode, 'runOnceForEachItem', [4180, 180]);
addNode('Is Markdown', 'n8n-nodes-base.if', {
  conditions: { string: [{ value1: '={{ $json.artifact.format }}', operation: 'equals', value2: 'md' }] },
}, { typeVersion: 2.2, position: [4400, 180] });
addHttp('Upload Markdown', {
  method: 'PUT',
  url: '={{ $json.signer.uploadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'text/markdown' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'text/markdown',
  body: '={{ $json.artifact.body }}',
  options: { response: { response: { responseFormat: 'text' } } },
}, [4620, 0]);
addCode('Prepare Markdown Artifact', prepareMarkdownArtifactCode, 'runOnceForEachItem', [4840, 0]);
addHttp('Upload PDF', {
  method: 'PUT',
  url: '={{ $json.signer.uploadUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'application/pdf' },
  ] },
  sendBody: true,
  contentType: 'binaryData',
  inputDataFieldName: 'data',
  options: { response: { response: { responseFormat: 'text' } } },
}, [4620, 360]);
addCode('Prepare PDF Artifact', preparePdfArtifactCode, 'runOnceForEachItem', [4840, 360]);
addNode('Merge Artifact Uploads', 'n8n-nodes-base.merge', {
  mode: 'append',
  numberInputs: 2,
}, { typeVersion: 3.2, position: [5060, 180] });
addCode('Prepare Artifact Lookup', artifactLookupCode, 'runOnceForEachItem', [5280, 180]);
addHttp('Lookup Artifact', {
  method: 'GET',
  url: '={{ $json.artifactLookupUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Accept', value: 'application/json' },
  ] },
  options: { response: { response: { responseFormat: 'json' } } },
}, [5500, 180]);
addCode('Merge Artifact Lookup', mergeArtifactLookupCode, 'runOnceForEachItem', [5720, 180]);
addHttp('Write Artifact Record', {
  method: '={{ $json.artifactWriteMethod }}',
  url: '={{ $json.artifactWriteUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.artifactBody) }}',
  options: { response: { response: { responseFormat: 'json' } } },
}, [5940, 180]);
addCode('Aggregate Artifact Records', aggregateArtifactsCode, 'runOnceForAllItems', [6160, 180]);
addCode('Prepare GitHub Lookup', githubLookupCode, 'runOnceForEachItem', [6380, 180]);
addHttp('Get GitHub File', {
  method: 'GET',
  url: '={{ $json.githubUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.GITHUB_TOKEN }}" },
    { name: 'Accept', value: 'application/vnd.github+json' },
    { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
  ] },
  options: { response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
}, [6600, 180]);
addCode('Parse GitHub File', githubResponseCode, 'runOnceForEachItem', [6820, 180]);
addCode('Build GitHub Request', githubRequestCode, 'runOnceForEachItem', [7040, 180]);
addHttp('Put GitHub File', {
  method: 'PUT',
  url: '={{ $json.githubUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.GITHUB_TOKEN }}" },
    { name: 'Accept', value: 'application/vnd.github+json' },
    { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
    { name: 'Content-Type', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.githubPayload) }}',
  options: { response: { response: { responseFormat: 'json' } } },
}, [7260, 180]);
addCode('Prepare Finalization Items', finalizationCode, 'runOnceForAllItems', [7480, 180]);
addHttp('Finalize PocketBase', {
  method: 'PATCH',
  url: '={{ $json.finalizationUrl }}',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Authorization', value: "={{ 'Bearer ' + $env.POCKETBASE_SERVER_TOKEN }}" },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'application/json' },
  ] },
  sendBody: true,
  contentType: 'raw',
  rawContentType: 'application/json',
  body: '={{ JSON.stringify($json.finalizationBody) }}',
  options: { response: { response: { responseFormat: 'json' } } },
}, [7700, 180]);

connect('Webhook', 'Validate Event');
connect('Validate Event', 'Get PocketBase Message');
connect('Get PocketBase Message', 'Merge Message');
connect('Merge Message', 'Prepare Document Lookup');
connect('Prepare Document Lookup', 'Get Existing Document');
connect('Get Existing Document', 'Prepare Document State');
connect('Prepare Document State', 'Is Duplicate');
connect('Is Duplicate', 'Duplicate Ignored', 0);
connect('Is Duplicate', 'Prepare Metadata Request', 1);
connect('Prepare Metadata Request', 'New API Metadata');
connect('New API Metadata', 'Parse Metadata');
connect('Parse Metadata', 'Build Document');
connect('Build Document', 'Prepare Document Write');
connect('Prepare Document Write', 'Write Document');
connect('Write Document', 'Merge Document Response');
connect('Merge Document Response', 'Prepare mdTOpdf Input');
connect('Prepare mdTOpdf Input', 'Create mdTOpdf Job');
connect('Create mdTOpdf Job', 'Parse mdTOpdf Job');
connect('Parse mdTOpdf Job', 'Upload mdTOpdf Markdown');
connect('Upload mdTOpdf Markdown', 'Parse mdTOpdf Upload');
connect('Parse mdTOpdf Upload', 'Mark mdTOpdf Uploaded');
connect('Mark mdTOpdf Uploaded', 'Parse mdTOpdf Uploaded');
connect('Parse mdTOpdf Uploaded', 'Queue mdTOpdf Job');
connect('Queue mdTOpdf Job', 'Parse mdTOpdf Queued');
connect('Parse mdTOpdf Queued', 'Prepare mdTOpdf Dispatch');
connect('Prepare mdTOpdf Dispatch', 'Dispatch mdTOpdf Action');
connect('Dispatch mdTOpdf Action', 'Parse mdTOpdf Dispatch');
connect('Parse mdTOpdf Dispatch', 'Wait mdTOpdf Action');
connect('Wait mdTOpdf Action', 'Get mdTOpdf Job');
connect('Get mdTOpdf Job', 'Parse mdTOpdf Job Status');
connect('Parse mdTOpdf Job Status', 'Is mdTOpdf Ready');
connect('Is mdTOpdf Ready', 'Download mdTOpdf PDF', 0);
connect('Is mdTOpdf Ready', 'Wait mdTOpdf Action', 1);
connect('Download mdTOpdf PDF', 'Select mdTOpdf PDF');
connect('Select mdTOpdf PDF', 'Merge PDF');
connect('Merge PDF', 'Create Artifact Items');
connect('Create Artifact Items', 'Sign Artifact Upload');
connect('Sign Artifact Upload', 'Merge Signer Response');
connect('Merge Signer Response', 'Is Markdown');
connect('Is Markdown', 'Upload Markdown', 0);
connect('Is Markdown', 'Upload PDF', 1);
connect('Upload Markdown', 'Prepare Markdown Artifact');
connect('Upload PDF', 'Prepare PDF Artifact');
connect('Prepare Markdown Artifact', 'Merge Artifact Uploads', 0, 0);
connect('Prepare PDF Artifact', 'Merge Artifact Uploads', 0, 1);
connect('Merge Artifact Uploads', 'Prepare Artifact Lookup');
connect('Prepare Artifact Lookup', 'Lookup Artifact');
connect('Lookup Artifact', 'Merge Artifact Lookup');
connect('Merge Artifact Lookup', 'Write Artifact Record');
connect('Write Artifact Record', 'Aggregate Artifact Records');
connect('Aggregate Artifact Records', 'Prepare GitHub Lookup');
connect('Prepare GitHub Lookup', 'Get GitHub File');
connect('Get GitHub File', 'Parse GitHub File');
connect('Parse GitHub File', 'Build GitHub Request');
connect('Build GitHub Request', 'Put GitHub File');
connect('Put GitHub File', 'Prepare Finalization Items');
connect('Prepare Finalization Items', 'Finalize PocketBase');

const workflow = {
  id: 'document-publish-main-v1',
  name: 'AnyWorkflow Document Publish',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    errorWorkflow: 'document-publish-error-v1',
    saveManualExecutions: true,
    saveExecutionProgress: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    executionTimeout: 1800,
  },
  versionId: 'document-publish-workflow-v1',
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(
    new URL('./document-publish.workflow.json', import.meta.url),
    `${JSON.stringify(workflow, null, 2)}\n`,
    'utf8',
  );
}
