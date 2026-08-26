import {
  buildDownloadGatewayUrl,
  contentTypeForFormat,
  parseArtifactReference,
} from '@/lib/document-publishing/contracts';
import { fetchWithNodeHttps, jsonError } from '@/lib/document-publishing/http';
import {
  IntegrationConfigurationError,
  readDocumentIntegrationConfig,
  requireConfig,
} from '@/lib/document-publishing/server-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{
    documentId: string;
    version: string;
    format: string;
  }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let reference;
  try {
    const params = await context.params;
    reference = parseArtifactReference({
      documentId: params.documentId,
      version: Number(params.version),
      format: params.format,
    });
  } catch {
    return jsonError(400, 'VALIDATION_ERROR', 'The document reference is invalid.');
  }

  try {
    const config = readDocumentIntegrationConfig();
    const required = requireConfig(config, [
      'blobDownloadGatewayUrl',
      'blobDownloadGatewaySecret',
    ] as const);
    const gatewayUrl = buildDownloadGatewayUrl(required.blobDownloadGatewayUrl, reference);
    const headers: Record<string, string> = { Accept: contentTypeForFormat(reference.format) };
    headers['X-Internal-Key'] = required.blobDownloadGatewaySecret;

    const upstream = await fetchWithNodeHttps(gatewayUrl, {
      headers,
      // EdgeOne custom domains can normalize a function request with a redirect.
      // The gateway URL is a trusted server-side configuration value.
      redirect: 'follow',
      cache: 'no-store',
    });
    if (upstream.status === 404) return jsonError(404, 'NOT_FOUND', 'The document file was not found.');
    if (!upstream.ok) {
      console.error('[document-download] Blob gateway failed', upstream.status);
      return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The document file is temporarily unavailable.');
    }

    const expectedContentType = contentTypeForFormat(reference.format);
    const actualContentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    if (!actualContentType.startsWith(expectedContentType)) {
      console.error('[document-download] Blob gateway returned an unexpected content type');
      return jsonError(502, 'UPSTREAM_INVALID', 'The document file returned an invalid content type.');
    }

    const extension = reference.format === 'pdf' ? 'pdf' : 'md';
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': `attachment; filename="document-${reference.documentId}-v${reference.version}.${extension}"`,
        'Content-Type': expectedContentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof IntegrationConfigurationError) {
      console.error('[document-download] configuration is incomplete', error.missing.join(','));
      return jsonError(503, 'NOT_CONFIGURED', 'Document downloads are not configured.');
    }
    console.error('[document-download] request failed', error instanceof Error ? error.name : 'unknown');
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The document file is temporarily unavailable.');
  }
}
