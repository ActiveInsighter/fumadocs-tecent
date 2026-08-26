import {
  artifactKey,
  contentTypeForFormat,
  type ArtifactReference,
} from './contracts';

export interface UploadSignerResponse {
  readonly key: string;
  readonly uploadUrl: string;
  readonly contentType: string;
  readonly expiresAt?: string;
}

export function normalizeUploadSignerResponse(
  value: unknown,
  reference: ArtifactReference,
): UploadSignerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Blob signer response.');
  }

  const input = value as Record<string, unknown>;
  const key = typeof input.key === 'string' ? input.key : '';
  const uploadUrl = typeof input.uploadUrl === 'string' ? input.uploadUrl : '';
  const contentType = typeof input.contentType === 'string' ? input.contentType : '';
  const expiresAt = input.expiresAt;

  if (key !== artifactKey(reference) || contentType !== contentTypeForFormat(reference.format)) {
    throw new Error('Invalid Blob signer response.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(uploadUrl);
  } catch {
    throw new Error('Invalid Blob signer response.');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('Invalid Blob signer response.');
  }

  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('Invalid Blob signer response.');
    }
  }

  return Object.freeze({
    key,
    uploadUrl,
    contentType,
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
  });
}
