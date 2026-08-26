import { parseArtifactReference } from '@/lib/document-publishing/contracts';
import {
  fetchWithTimeout,
  InvalidJsonBodyError,
  jsonError,
  readJsonBody,
  safeEqualSecret,
} from '@/lib/document-publishing/http';
import {
  IntegrationConfigurationError,
  readDocumentIntegrationConfig,
  requireConfig,
} from '@/lib/document-publishing/server-config';
import { normalizeUploadSignerResponse } from '@/lib/document-publishing/signer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = readDocumentIntegrationConfig();
    const required = requireConfig(config, [
      'fumadocsBlobUploadKey',
      'blobSignerUrl',
      'blobSignerSecret',
    ] as const);

    if (!safeEqualSecret(request.headers.get('x-internal-key'), required.fumadocsBlobUploadKey)) {
      return jsonError(401, 'UNAUTHENTICATED', 'A trusted workflow key is required.');
    }

    let reference;
    try {
      reference = parseArtifactReference(await readJsonBody(request, 16 * 1024));
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        return jsonError(413, 'REQUEST_TOO_LARGE', 'The upload request is invalid or too large.');
      }
      return jsonError(422, 'VALIDATION_ERROR', 'The upload request is invalid.');
    }

    const signerResponse = await fetchWithTimeout(required.blobSignerUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Internal-Key': required.blobSignerSecret,
      },
      body: JSON.stringify(reference),
      cache: 'no-store',
    });
    if (!signerResponse.ok) {
      console.error('[blob-upload-url] signer rejected request', signerResponse.status);
      return jsonError(502, 'UPSTREAM_REJECTED', 'The Blob upload address could not be created.');
    }

    const result = normalizeUploadSignerResponse(await signerResponse.json(), reference);
    return Response.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof IntegrationConfigurationError) {
      console.error('[blob-upload-url] configuration is incomplete', error.missing.join(','));
      return jsonError(503, 'NOT_CONFIGURED', 'Blob upload is not configured.');
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      console.error('[blob-upload-url] signer response was invalid');
      return jsonError(502, 'UPSTREAM_INVALID', 'The Blob signer returned an invalid response.');
    }
    console.error('[blob-upload-url] request failed');
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The Blob service is temporarily unavailable.');
  }
}
