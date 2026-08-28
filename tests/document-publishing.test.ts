import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  artifactKey,
  buildDownloadGatewayUrl,
  parseArtifactReference,
} from '../lib/document-publishing/contracts';
import {
  buildN8nTaskEnrichEvent,
  parseAnyWorkflowTaskPublishTrigger,
} from '../lib/document-publishing/ingest';
import { normalizeUploadSignerResponse } from '../lib/document-publishing/signer';

const TASK_ID = 'task12345678901';
const MESSAGE_ID = 'msg123456789012';

describe('document publishing contracts', () => {
  it('bypasses EdgeOne fetch proxy failures when downloading through the Blob gateway', async () => {
    vi.resetModules();
    vi.stubEnv('BLOB_DOWNLOAD_GATEWAY_URL', 'https://blob.example.test/download');
    vi.stubEnv('BLOB_DOWNLOAD_GATEWAY_SECRET', 'a'.repeat(32));

    const responses = [
      {
        statusCode: 302,
        headers: {
          location: `https://blob.example.test/download/tasks/${TASK_ID}/1/${MESSAGE_ID}/md`,
        },
      },
      { statusCode: 404, headers: {} as Record<string, string> },
    ];
    const nativeRequest = vi.fn(
      (
        _url: string | URL,
        _options: object,
        callback: (response: PassThrough & { headers: Record<string, string>; statusCode: number }) => void,
      ) => {
        const nextResponse = responses.shift();
        if (!nextResponse) throw new Error('The fake HTTPS server ran out of responses.');

        const response = new PassThrough() as PassThrough & {
          headers: Record<string, string>;
          statusCode: number;
        };
        response.headers = nextResponse.headers;
        response.statusCode = nextResponse.statusCode;

        const request = new EventEmitter() as EventEmitter & {
          destroy: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          setTimeout: ReturnType<typeof vi.fn>;
        };
        request.destroy = vi.fn((error?: Error) => {
          if (error) request.emit('error', error);
          return request;
        });
        request.end = vi.fn(() => {
          callback(response);
          response.end();
          return request;
        });
        request.setTimeout = vi.fn().mockReturnValue(request);
        return request;
      },
    );
    vi.doMock('node:https', () => ({ request: nativeRequest }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const cause = Object.assign(new Error('getaddrinfo ENOTFOUND {{pages_proxy_host}}'), {
          code: 'ENOTFOUND',
        });
        throw Object.assign(new TypeError('fetch failed'), { cause });
      }),
    );

    try {
      const { GET } = await import(
        '../app/download/tasks/[taskRecordId]/[version]/[messageRecordId]/[format]/route'
      );
      const response = await GET(
        new Request(`https://fumadocs.example.test/download/tasks/${TASK_ID}/1/${MESSAGE_ID}/md`),
        {
          params: Promise.resolve({
            taskRecordId: TASK_ID,
            version: '1',
            messageRecordId: MESSAGE_ID,
            format: 'md',
          }),
        },
      );

      expect(response.status).toBe(404);
      expect(nativeRequest).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('node:https');
      vi.resetModules();
    }
  });

  it('uses a strong Blob read so a missing artifact is reported as 404', async () => {
    vi.resetModules();
    const get = async (
      _key: string,
      options?: { consistency?: string },
    ): Promise<null> => {
      if (options?.consistency !== 'strong') {
        throw new Error('eventual Blob reads are unavailable in this test');
      }
      return null;
    };
    (vi.doMock as unknown as (
      path: string,
      factory: () => unknown,
      options?: { virtual?: boolean },
    ) => void)(
      '@edgeone/pages-blob',
      () => ({ getStore: () => ({ get }) }),
      { virtual: true },
    );

    const { onRequestGet } = await import(
      // @ts-expect-error EdgeOne function route has no local declaration file.
      '../edgeone/cloud-functions/download/tasks/[taskRecordId]/[version]/[messageRecordId]/[format].js'
    );
    const response = await onRequestGet({
      request: new Request(
        `https://fumadocs-upload.any1.tech/download/tasks/${TASK_ID}/1/${MESSAGE_ID}/md`,
        {
          headers: { 'X-Internal-Key': 'a'.repeat(32) },
        },
      ),
      params: { taskRecordId: TASK_ID, version: '1', messageRecordId: MESSAGE_ID, format: 'md' },
      env: { DOWNLOAD_GATEWAY_SECRET: 'a'.repeat(32) },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    vi.doUnmock('@edgeone/pages-blob');
    vi.resetModules();
  });

  it('creates a versioned task-scoped Blob key and gateway URL from a safe reference', () => {
    const reference = parseArtifactReference({
      taskRecordId: TASK_ID,
      messageRecordId: MESSAGE_ID,
      version: 3,
      format: 'pdf',
    });

    expect(artifactKey(reference)).toBe(
      `documents/tasks/${TASK_ID}/v3/messages/${MESSAGE_ID}/document.pdf`,
    );
    expect(buildDownloadGatewayUrl('https://blob.example.test/download', reference)).toBe(
      `https://blob.example.test/download/tasks/${TASK_ID}/3/${MESSAGE_ID}/pdf`,
    );
  });

  it('rejects traversal and invalid artifact formats at the contract boundary', () => {
    expect(() =>
      parseArtifactReference({ taskRecordId: '../private', messageRecordId: MESSAGE_ID, version: 1, format: 'pdf' }),
    ).toThrow('Invalid artifact reference');
    expect(() =>
      parseArtifactReference({ taskRecordId: TASK_ID, messageRecordId: 'msg-1', version: 1, format: 'pdf' }),
    ).toThrow('Invalid artifact reference');
    expect(() =>
      parseArtifactReference({ taskRecordId: TASK_ID, messageRecordId: MESSAGE_ID, version: 0, format: 'pdf' }),
    ).toThrow('Invalid artifact reference');
    expect(() =>
      parseArtifactReference({ taskRecordId: TASK_ID, messageRecordId: MESSAGE_ID, version: 1, format: 'html' }),
    ).toThrow('Invalid artifact reference');
  });

  it('parses task publish triggers and defaults build flags to true', () => {
    const trigger = parseAnyWorkflowTaskPublishTrigger({
      schemaVersion: 2,
      kind: 'task',
      taskRecordId: TASK_ID,
      checksum: 'a'.repeat(64),
    });
    expect(trigger).toMatchObject({ buildMd: true, buildPdf: true });

    expect(() =>
      parseAnyWorkflowTaskPublishTrigger({
        schemaVersion: 1,
        kind: 'message',
        taskRecordId: TASK_ID,
        checksum: 'a'.repeat(64),
      }),
    ).toThrow('Invalid task publish trigger');
    expect(() =>
      parseAnyWorkflowTaskPublishTrigger({
        schemaVersion: 2,
        kind: 'task',
        taskRecordId: 'TASK-1',
        checksum: 'a'.repeat(64),
      }),
    ).toThrow('Invalid task publish trigger');
  });

  it('derives a deterministic task enrichment event id per owner and task', () => {
    const trigger = parseAnyWorkflowTaskPublishTrigger({
      schemaVersion: 2,
      kind: 'task',
      taskRecordId: TASK_ID,
      checksum: 'a'.repeat(64),
      buildMd: true,
      buildPdf: false,
    });
    const event = buildN8nTaskEnrichEvent(trigger, 'client123456789');
    const again = buildN8nTaskEnrichEvent(trigger, 'client123456789');

    expect(event.eventId).toBe(again.eventId);
    expect(event.eventId).toMatch(/^[a-f0-9]{64}$/u);
    expect(event).toMatchObject({
      ownerId: 'client123456789',
      source: 'anyworkflow',
      buildPdf: false,
    });
  });

  it('accepts only a signer response for the exact requested key and MIME type', () => {
    const reference = parseArtifactReference({
      taskRecordId: TASK_ID,
      messageRecordId: MESSAGE_ID,
      version: 3,
      format: 'md',
    });

    expect(
      normalizeUploadSignerResponse(
        {
          key: artifactKey(reference),
          uploadUrl: 'https://blob.example.test/upload/signed',
          contentType: 'text/markdown',
          expiresAt: '2026-08-26T00:05:00.000Z',
        },
        reference,
      ),
    ).toMatchObject({ key: artifactKey(reference), contentType: 'text/markdown' });

    expect(() =>
      normalizeUploadSignerResponse(
        {
          key: `documents/tasks/${TASK_ID}/v3/messages/othermsg12345/document.md`,
          uploadUrl: 'https://blob.example.test/upload/signed',
          contentType: 'text/markdown',
        },
        reference,
      ),
    ).toThrow('Invalid Blob signer response');
  });

  it('keeps the checked-in n8n workflows importable, secret-free, and cross-linked', () => {
    const readWorkflow = (file: string) =>
      JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as {
        id?: string;
        name?: string;
        nodes: Array<{
          name: string;
          type: string;
          parameters?: { jsCode?: string; path?: string };
        }>;
        connections: Record<string, { main: Array<Array<{ node: string }>> }>;
        settings?: { errorWorkflow?: string };
      };

    const metadata = readWorkflow('../n8n/task-metadata.workflow.json');
    const publish = readWorkflow('../n8n/task-document-publish.workflow.json');
    const error = readWorkflow('../n8n/task-publish-error.workflow.json');

    expect(metadata.id).toBe('task-metadata-enrichment-v1');
    expect(metadata.name).toBe('AnyWorkflow Task Metadata Enrichment');
    expect(metadata.settings?.errorWorkflow).toBe('task-publish-error-v1');
    expect(publish.id).toBe('task-document-publish-v1');
    expect(publish.name).toBe('AnyWorkflow Task Document Publish');
    expect(publish.settings?.errorWorkflow).toBe('task-publish-error-v1');
    expect(error.id).toBe('task-publish-error-v1');
    expect(error.name).toBe('AnyWorkflow Task Publish Error');

    const metadataNames = new Set(metadata.nodes.map((node) => node.name));
    expect([...metadataNames]).toEqual(
      expect.arrayContaining([
        'Webhook',
        'Validate Event',
        'Get PocketBase Task',
        'Evaluate Job State',
        'Is Duplicate',
        'Lock Metadata',
        'Build Tree',
        'New API Message Metadata',
        'New API Act Metadata',
        'New API Event Metadata',
        'New API Task Metadata',
        'Write Metadata',
        'Create Publish Job',
        'Trigger Task Publish',
      ]),
    );

    const publishNames = new Set(publish.nodes.map((node) => node.name));
    expect([...publishNames]).toEqual(
      expect.arrayContaining([
        'Webhook',
        'Validate Event',
        'Get Publish Job',
        'Lock Publish Job',
        'Build Snapshot',
        'Write Documents',
        'Mark Job Building',
        'Create PDF Jobs',
        'Upload PDF Markdown',
        'Dispatch PDF Batch',
        'Get PDF Batch Status',
        'Is PDF Batch Ready',
        'Download PDFs',
        'Sign Artifact Uploads',
        'Upload Markdown Artifacts',
        'Upload PDF Artifacts',
        'Create GitHub Tree',
        'Create GitHub Commit',
        'Update GitHub Ref',
        'Write Finalization',
        'Mark Job Published',
      ]),
    );

    const errorNames = new Set(error.nodes.map((node) => node.name));
    expect([...errorNames]).toEqual(
      expect.arrayContaining([
        'Error Trigger',
        'Extract Failure Context',
        'Mark Task Metadata Failed',
        'Mark Publish Job Failed',
        'Write Document Failures',
      ]),
    );

    const metadataWebhook = metadata.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
    const publishWebhook = publish.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');
    expect(metadataWebhook?.parameters?.path).toBe('anyworkflow-task-enrich');
    expect(publishWebhook?.parameters?.path).toBe('anyworkflow-task-publish');

    const publishText = JSON.stringify(publish);
    expect(publishText).toContain('build-pdf-api.yml/dispatches');
    expect(publishText).toContain('/rest/v1/pdf_jobs');
    expect(publishText).toContain('/git/trees');
    expect(publishText).toContain('content/docs/tasks/');
    expect(publishText).toContain('publishKey');

    for (const workflow of [metadata, publish, error]) {
      expect(JSON.stringify(workflow)).not.toMatch(
        /(?:eyJ|(?<![A-Za-z])sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/u,
      );
      for (const node of workflow.nodes) {
        const jsCode = node.parameters?.jsCode;
        if (jsCode) expect(() => new Function(jsCode)).not.toThrow();
      }
    }
  });

  it('deploys only the EdgeOne Blob functions through a pinned CLI workflow', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/deploy-edgeone-functions.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain("'edgeone/**'");
    expect(workflow).toContain('edgeone makers deploy ./edgeone');
    expect(workflow).toContain('EDGEONE_CLI_VERSION: 1.6.19');
    expect(workflow).toContain('edgeone@${EDGEONE_CLI_VERSION}');
    expect(workflow).toContain('EDGEONE_API_TOKEN: ${{ secrets.EDGEONE_API_TOKEN }}');
    expect(workflow).toContain('EDGEONE_PROJECT_NAME: ${{ vars.EDGEONE_PROJECT_NAME }}');
    expect(workflow).toContain('edgeone makers link');
    expect(workflow).toContain('https://blob-sts.edgeone.site/');
    expect(workflow).toContain('signer_with_key=');
    expect(workflow).not.toContain('md-to-pdf');
    expect(workflow).not.toMatch(/^\s*EDGEONE_API_TOKEN:\s*(?!\$\{\{)[^\s#]/mu);
  });

  it('keeps per-item Code nodes compatible with n8n execution mode', () => {
    const workflowFiles = [
      '../n8n/task-metadata.workflow.json',
      '../n8n/task-document-publish.workflow.json',
      '../n8n/task-publish-error.workflow.json',
    ];

    for (const workflowFile of workflowFiles) {
      const workflow = JSON.parse(
        readFileSync(new URL(workflowFile, import.meta.url), 'utf8'),
      ) as {
        nodes: Array<{ name: string; parameters?: { mode?: string; jsCode?: string } }>;
      };

      for (const node of workflow.nodes) {
        if (node.parameters?.mode !== 'runOnceForEachItem') continue;
        const jsCode = node.parameters.jsCode ?? '';
        expect(jsCode, `${workflowFile}:${node.name}`).not.toContain('$input.first()');
        expect(jsCode, `${workflowFile}:${node.name}`).not.toContain('$input.all()');
        expect(jsCode, `${workflowFile}:${node.name}`).not.toContain('crypto.randomUUID');
        expect(jsCode, `${workflowFile}:${node.name}`).not.toContain('new URL(');
      }
    }
  });

  it('places Node.js Blob handlers in EdgeOne cloud-functions routes', () => {
    const cloudFunctionsDir = new URL('../edgeone/cloud-functions/', import.meta.url);
    const legacyFunctionsDir = new URL('../edgeone/functions/', import.meta.url);

    expect(existsSync(cloudFunctionsDir)).toBe(true);
    expect(existsSync(new URL('api/blob/upload-url.js', cloudFunctionsDir))).toBe(true);
    expect(
      existsSync(
        new URL('download/tasks/[taskRecordId]/[version]/[messageRecordId]/[format].js', cloudFunctionsDir),
      ),
    ).toBe(true);
    expect(existsSync(legacyFunctionsDir)).toBe(false);
  });

  it('keeps the Blob gateway on a stable custom domain', () => {
    const functionsWorkflow = readFileSync(
      new URL('../.github/workflows/deploy-edgeone-functions.yml', import.meta.url),
      'utf8',
    );
    const docsWorkflow = readFileSync(
      new URL('../.github/workflows/deploy-edgeone-docs.yml', import.meta.url),
      'utf8',
    );

    expect(functionsWorkflow).toContain('CreatePagesZoneCustomDomain');
    expect(functionsWorkflow).toContain('fumadocs-upload.any1.tech');
    expect(docsWorkflow).toContain('https://fumadocs-upload.any1.tech/api/blob/upload-url');
    expect(docsWorkflow).toContain('https://fumadocs-upload.any1.tech/download');
    expect(docsWorkflow).not.toContain('fumadocs-upload-mimnflju.edgeone.cool');
  });

  it('does not require third-party blog images during the production build', () => {
    const sourceConfig = readFileSync(new URL('../source.config.ts', import.meta.url), 'utf8');

    expect(sourceConfig).toMatch(/remarkImageOptions:\s*\{\s*external:\s*false\s*\}/u);
  });
});
