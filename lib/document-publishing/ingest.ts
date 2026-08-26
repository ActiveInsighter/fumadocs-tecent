import { createHash } from 'node:crypto';

export interface AnyWorkflowPublishTrigger {
  readonly schemaVersion: 1;
  readonly kind: 'message';
  readonly messageRecordId: string;
  readonly entryKey: string;
  readonly checksum: string;
}

export interface N8nPublishEvent extends AnyWorkflowPublishTrigger {
  readonly eventId: string;
  readonly ownerId: string;
  readonly source: 'anyworkflow';
}

const RECORD_ID_PATTERN = /^[a-z0-9]{15}$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const ENTRY_KEY_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

function isValidEntryKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !ENTRY_KEY_CONTROL_PATTERN.test(value)
  );
}

export function parseAnyWorkflowPublishTrigger(value: unknown): AnyWorkflowPublishTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid document publish trigger.');
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    input.kind !== 'message' ||
    typeof input.messageRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(input.messageRecordId) ||
    !isValidEntryKey(input.entryKey) ||
    typeof input.checksum !== 'string' ||
    !CHECKSUM_PATTERN.test(input.checksum)
  ) {
    throw new Error('Invalid document publish trigger.');
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: 'message',
    messageRecordId: input.messageRecordId,
    entryKey: input.entryKey,
    checksum: input.checksum,
  });
}

export function parseBearerToken(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/u.exec(value.trim());
  if (!match || match[1].length > 16_384) return undefined;
  return match[1];
}

export function buildN8nPublishEvent(
  trigger: AnyWorkflowPublishTrigger,
  ownerId: string,
): N8nPublishEvent {
  const eventId = createHash('sha256')
    .update(`${ownerId}\u0000${trigger.messageRecordId}\u0000${trigger.checksum}`)
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
