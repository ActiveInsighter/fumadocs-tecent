import { request as nodeHttpsRequest } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON request body.');
    this.name = 'InvalidJsonBodyError';
  }
}

export async function readJsonBody<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new InvalidJsonBodyError();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new InvalidJsonBodyError();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new InvalidJsonBodyError();
    chunks.push(bytes);
    totalBytes = bytes.byteLength;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
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

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      redirect: init.redirect ?? 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function copyNodeResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function nodeResponseBody(response: IncomingMessage): ReadableStream<Uint8Array> {
  return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
}

function fetchNodeHttpsOnce(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (init.body !== undefined && init.body !== null) {
      reject(new Error('The Node HTTPS transport does not support request bodies.'));
      return;
    }
    if (init.signal?.aborted) {
      reject(new DOMException('The request was aborted.', 'AbortError'));
      return;
    }

    let request: ClientRequest;
    let settled = false;
    const onAbort = () => {
      request.destroy(new DOMException('The request was aborted.', 'AbortError'));
    };
    const onError = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    try {
      request = nodeHttpsRequest(
        url,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers).entries()),
        },
        (response) => {
          if (settled) {
            response.resume();
            return;
          }

          const status = response.statusCode ?? 502;
          if (status < 100 || status > 599) {
            response.resume();
            onError(new Error(`The Blob gateway returned an invalid HTTP status: ${status}.`));
            return;
          }

          settled = true;
          request.setTimeout(0);
          resolve(
            new Response(nodeResponseBody(response), {
              status,
              headers: copyNodeResponseHeaders(response),
            }),
          );
        },
      );
      request.once('error', onError);
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('The Blob gateway request timed out.'));
      });
      if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
      request.end();
    } catch (error) {
      onError(error instanceof Error ? error : new Error('The Blob gateway request failed.'));
    }
  });
}

/**
 * Fetches the private Blob gateway without using EdgeOne's platform fetch proxy.
 * The EdgeOne Node runtime can expose a malformed proxy target to global fetch;
 * Node's built-in HTTPS client avoids that platform-specific interception.
 */
export async function fetchWithNodeHttps(
  input: string | URL,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  let url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('The Blob gateway URL must use HTTPS.');

  const redirectMode = init.redirect ?? 'error';
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchNodeHttpsOnce(url, init, timeoutMs);
    if (redirectMode !== 'follow' || !REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount >= MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new Error('The Blob gateway returned too many redirects.');
    }

    const nextUrl = new URL(location, url);
    if (nextUrl.protocol !== 'https:' || nextUrl.origin !== url.origin) {
      await response.body?.cancel();
      throw new Error('The Blob gateway redirect is not trusted.');
    }

    await response.body?.cancel();
    url = nextUrl;
  }
}

export function safeEqualSecret(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
