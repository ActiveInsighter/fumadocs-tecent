export type DocumentFormat = 'md' | 'pdf';

export interface ArtifactReference {
  readonly documentId: string;
  readonly version: number;
  readonly format: DocumentFormat;
}

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_VERSION = 999_999_999;

export function parseArtifactReference(value: unknown): ArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid document reference.');
  }

  const input = value as Record<string, unknown>;
  const documentId = typeof input.documentId === 'string' ? input.documentId.trim() : '';
  const version =
    typeof input.version === 'number' && Number.isSafeInteger(input.version)
      ? input.version
      : Number.NaN;
  const format = input.format;

  if (
    !DOCUMENT_ID_PATTERN.test(documentId) ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION ||
    (format !== 'md' && format !== 'pdf')
  ) {
    throw new Error('Invalid document reference.');
  }

  return Object.freeze({
    documentId,
    version,
    format,
  });
}

export function artifactKey(reference: ArtifactReference): string {
  return `documents/${reference.documentId}/v${reference.version}/document.${reference.format}`;
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
  url.pathname = `${basePath}/${encodeURIComponent(reference.documentId)}/${reference.version}/${reference.format}`;
  return url.toString();
}

export function isLoopbackHost(hostname: string, protocol: string): boolean {
  return (
    protocol === 'http:' &&
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
