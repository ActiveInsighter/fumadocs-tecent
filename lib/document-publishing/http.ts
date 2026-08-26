import { timingSafeEqual } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15_000;

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

export function safeEqualSecret(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
