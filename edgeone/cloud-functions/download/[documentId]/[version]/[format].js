import { getStore } from '@edgeone/pages-blob';

import {
  ARTIFACT_STORE_NAME,
  artifactContentType,
  artifactKey,
  jsonError,
  parseArtifactParams,
  requireInternalKey,
  safeFilename,
} from '../../../_shared/artifact.js';

export async function onRequestGet(context) {
  if (!requireInternalKey(context.request, context.env.DOWNLOAD_GATEWAY_SECRET)) {
    return jsonError(401, 'UNAUTHENTICATED', 'A trusted internal key is required.');
  }

  let reference;
  try {
    reference = parseArtifactParams(context.params);
  } catch {
    return jsonError(400, 'VALIDATION_ERROR', 'The artifact reference is invalid.');
  }

  try {
    const stream = await getStore(ARTIFACT_STORE_NAME).get(artifactKey(reference), {
      type: 'stream',
    });
    if (!stream) return jsonError(404, 'NOT_FOUND', 'The document file was not found.');

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${safeFilename(reference)}"`,
        'Content-Type': reference.format === 'md'
          ? 'text/markdown; charset=utf-8'
          : artifactContentType(reference.format),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[blob-download] read failed', error instanceof Error ? error.message : 'unknown error');
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The document file is unavailable.');
  }
}
