import { getStore } from '@edgeone/pages-blob';

import {
  ARTIFACT_STORE_NAME,
  artifactContentType,
  artifactKey,
  jsonError,
  parseArtifactParams,
  requireInternalKey,
} from '../../_shared/artifact.js';

export async function onRequestPost(context) {
  if (!requireInternalKey(context.request, context.env.INTERNAL_API_KEY)) {
    return jsonError(401, 'UNAUTHENTICATED', 'A trusted internal key is required.');
  }

  let reference;
  try {
    const declaredLength = Number(context.request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      return jsonError(413, 'REQUEST_TOO_LARGE', 'The artifact reference is too large.');
    }
    const body = new Uint8Array(await context.request.arrayBuffer());
    if (body.byteLength > 16 * 1024) {
      return jsonError(413, 'REQUEST_TOO_LARGE', 'The artifact reference is too large.');
    }
    reference = parseArtifactParams(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
    );
  } catch {
    return jsonError(422, 'VALIDATION_ERROR', 'The artifact reference is invalid.');
  }

  try {
    const contentType = artifactContentType(reference.format);
    const result = await getStore(ARTIFACT_STORE_NAME).createUploadUrl(
      artifactKey(reference),
      { expireSeconds: 300, contentType },
    );
    if (!result?.url || typeof result.url !== 'string') {
      return jsonError(502, 'UPSTREAM_INVALID', 'The Blob signer returned an invalid address.');
    }
    return Response.json(
      {
        key: artifactKey(reference),
        uploadUrl: result.url,
        ...(typeof result.expiresAt === 'string' ? { expiresAt: result.expiresAt } : {}),
        contentType,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    console.error('[blob-upload-url] signer failed', error instanceof Error ? error.message : 'unknown error');
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The Blob upload address is unavailable.');
  }
}
