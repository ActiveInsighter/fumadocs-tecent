import { timingSafeEqual } from 'node:crypto';

export const ARTIFACT_STORE_NAME = 'document-artifacts';

const RECORD_ID_PATTERN = /^[a-z0-9]{15}$/u;
const MAX_VERSION = 999_999_999;

export function parseArtifactParams(value) {
  const taskRecordId = typeof value?.taskRecordId === 'string' ? value.taskRecordId.trim() : '';
  const messageRecordId =
    typeof value?.messageRecordId === 'string' ? value.messageRecordId.trim() : '';
  const version = Number(value?.version);
  const format = value?.format;
  if (
    !RECORD_ID_PATTERN.test(taskRecordId) ||
    !RECORD_ID_PATTERN.test(messageRecordId) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > MAX_VERSION ||
    (format !== 'md' && format !== 'pdf')
  ) {
    throw new Error('Invalid artifact reference.');
  }
  return { taskRecordId, messageRecordId, version, format };
}

export function artifactKey({ taskRecordId, messageRecordId, version, format }) {
  return `documents/tasks/${taskRecordId}/v${version}/messages/${messageRecordId}/document.${format}`;
}

export function artifactContentType(format) {
  return format === 'pdf' ? 'application/pdf' : 'text/markdown';
}

export function requireInternalKey(request, expected) {
  if (typeof expected !== 'string' || expected.length < 16) return false;
  const provided = request.headers.get('x-internal-key');
  if (!provided) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function safeFilename(reference) {
  const extension = reference.format === 'pdf' ? 'pdf' : 'md';
  return `document-${reference.messageRecordId}-v${reference.version}.${extension}`;
}

export function jsonError(status, code, message) {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
