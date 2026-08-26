import {
  buildN8nPublishEvent,
  parseAnyWorkflowPublishTrigger,
  parseBearerToken,
  parsePocketBaseOwner,
} from '@/lib/document-publishing/ingest';
import {
  fetchWithTimeout,
  InvalidJsonBodyError,
  jsonError,
  readJsonBody,
} from '@/lib/document-publishing/http';
import {
  IntegrationConfigurationError,
  readDocumentIntegrationConfig,
  requireConfig,
} from '@/lib/document-publishing/server-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (!token) return jsonError(401, 'UNAUTHENTICATED', 'PocketBase authentication is required.');

  let trigger;
  try {
    trigger = parseAnyWorkflowPublishTrigger(await readJsonBody(request));
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return jsonError(413, 'REQUEST_TOO_LARGE', 'The publish request is invalid or too large.');
    }
    return jsonError(422, 'VALIDATION_ERROR', 'The publish request is invalid.');
  }

  let config;
  try {
    config = readDocumentIntegrationConfig();
    const required = requireConfig(config, [
      'pocketBaseUrl',
      'n8nWebhookUrl',
      'n8nWebhookSecret',
    ] as const);

    const pocketBaseResponse = await fetchWithTimeout(
      `${required.pocketBaseUrl}/api/collections/aw_clients/auth-refresh`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      },
    );
    if (pocketBaseResponse.status === 401 || pocketBaseResponse.status === 403) {
      return jsonError(401, 'UNAUTHENTICATED', 'PocketBase authentication is required.');
    }
    if (!pocketBaseResponse.ok) {
      console.error('[document-ingest] PocketBase auth refresh failed', pocketBaseResponse.status);
      return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The document service is temporarily unavailable.');
    }

    const ownerId = parsePocketBaseOwner(await pocketBaseResponse.json());
    const event = buildN8nPublishEvent(trigger, ownerId);
    const n8nResponse = await fetchWithTimeout(required.n8nWebhookUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Internal-Key': required.n8nWebhookSecret,
      },
      body: JSON.stringify(event),
      cache: 'no-store',
    });
    if (!n8nResponse.ok) {
      console.error('[document-ingest] n8n webhook rejected request', n8nResponse.status);
      return jsonError(502, 'UPSTREAM_REJECTED', 'The document workflow could not be started.');
    }

    return Response.json(
      { accepted: true, eventId: event.eventId },
      {
        status: 202,
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    if (error instanceof IntegrationConfigurationError) {
      console.error('[document-ingest] configuration is incomplete', error.missing.join(','));
      return jsonError(503, 'NOT_CONFIGURED', 'Document publishing is not configured.');
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      console.error('[document-ingest] upstream response was invalid');
      return jsonError(502, 'UPSTREAM_INVALID', 'The document service returned an invalid response.');
    }
    console.error('[document-ingest] request failed');
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', 'The document service is temporarily unavailable.');
  }
}
