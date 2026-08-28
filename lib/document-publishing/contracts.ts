export type DocumentFormat = 'md' | 'pdf';

export interface ArtifactReference {
  readonly taskRecordId: string;
  readonly messageRecordId: string;
  readonly version: number;
  readonly format: DocumentFormat;
}

const RECORD_ID_PATTERN = /^[a-z0-9]{15}$/u;
const MAX_VERSION = 999_999_999;

export function parseArtifactReference(value: unknown): ArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid artifact reference.');
  }

  const input = value as Record<string, unknown>;
  const taskRecordId =
    typeof input.taskRecordId === 'string' ? input.taskRecordId.trim() : '';
  const messageRecordId =
    typeof input.messageRecordId === 'string' ? input.messageRecordId.trim() : '';
  const version =
    typeof input.version === 'number' && Number.isSafeInteger(input.version)
      ? input.version
      : Number.NaN;
  const format = input.format;

  if (
    !RECORD_ID_PATTERN.test(taskRecordId) ||
    !RECORD_ID_PATTERN.test(messageRecordId) ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION ||
    (format !== 'md' && format !== 'pdf')
  ) {
    throw new Error('Invalid artifact reference.');
  }

  return Object.freeze({
    taskRecordId,
    messageRecordId,
    version,
    format,
  });
}

export function artifactKey(reference: ArtifactReference): string {
  return `documents/tasks/${reference.taskRecordId}/v${reference.version}/messages/${reference.messageRecordId}/document.${reference.format}`;
}

export function contentTypeForFormat(format: DocumentFormat): string {
  return format === 'pdf' ? 'application/pdf' : 'text/markdown';
}

export function buildDownloadGatewayUrl(
  baseUrl: string,
  reference: ArtifactReference,
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname, url.protocol)) {
    throw new Error('Invalid Blob gateway URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Blob gateway URL.');
  }

  const basePath = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${basePath}/tasks/${reference.taskRecordId}/${reference.version}/${reference.messageRecordId}/${reference.format}`;
  return url.toString();
}

export function isLoopbackHost(hostname: string, protocol: string): boolean {
  return (
    protocol === 'http' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
  );
}

export function isSafeServiceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || isLoopbackHost(url.hostname, url.protocol)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
