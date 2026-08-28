import { createHash } from 'node:crypto';

export interface AnyWorkflowTaskPublishTrigger {
  readonly schemaVersion: 2;
  readonly kind: 'task';
  readonly taskRecordId: string;
  readonly checksum: string;
  readonly buildMd: boolean;
  readonly buildPdf: boolean;
}

export interface N8nTaskEnrichEvent extends AnyWorkflowTaskPublishTrigger {
  readonly eventId: string;
  readonly ownerId: string;
  readonly source: 'anyworkflow';
}

const RECORD_ID_PATTERN = /^[a-z0-9]{15}$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;

export function parseAnyWorkflowTaskPublishTrigger(
  value: unknown,
): AnyWorkflowTaskPublishTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid task publish trigger.');
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 2 ||
    input.kind !== 'task' ||
    typeof input.taskRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(input.taskRecordId) ||
    typeof input.checksum !== 'string' ||
    !CHECKSUM_PATTERN.test(input.checksum)
  ) {
    throw new Error('Invalid task publish trigger.');
  }
  const buildMd = input.buildMd === undefined ? true : input.buildMd === true;
  const buildPdf = input.buildPdf === undefined ? true : input.buildPdf === true;

  return Object.freeze({
    schemaVersion: 2,
    kind: 'task',
    taskRecordId: input.taskRecordId,
    checksum: input.checksum,
    buildMd,
    buildPdf,
  });
}

export function parseBearerToken(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/u.exec(value.trim());
  if (!match || match[1].length > 16_384) return undefined;
  return match[1];
}

export function buildN8nTaskEnrichEvent(
  trigger: AnyWorkflowTaskPublishTrigger,
  ownerId: string,
): N8nTaskEnrichEvent {
  const eventId = createHash('sha256')
    .update(`${ownerId}\u0000${trigger.taskRecordId}\u0000${trigger.checksum}`)
    .digest('hex');
  return Object.freeze({
    ...trigger,
    eventId,
    ownerId,
    source: 'anyworkflow',
  });
}

export function parsePocketBaseOwner(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid PocketBase auth response.');
  }
  const record = (value as Record<string, unknown>).record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Invalid PocketBase auth response.');
  }
  const authRecord = record as Record<string, unknown>;
  if (authRecord.collectionName !== 'aw_clients' || typeof authRecord.id !== 'string') {
    throw new Error('Invalid PocketBase auth response.');
  }
  if (!RECORD_ID_PATTERN.test(authRecord.id)) throw new Error('Invalid PocketBase auth response.');
  return authRecord.id;
}
