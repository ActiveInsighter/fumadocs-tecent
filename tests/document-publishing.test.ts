import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  artifactKey,
  buildDownloadGatewayUrl,
  parseArtifactReference,
} from '../lib/document-publishing/contracts';
import { parseAnyWorkflowPublishTrigger } from '../lib/document-publishing/ingest';
import { normalizeUploadSignerResponse } from '../lib/document-publishing/signer';

describe('document publishing contracts', () => {
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
      '../edgeone/cloud-functions/download/[documentId]/[version]/[format].js'
    );
    const response = await onRequestGet({
      request: new Request('https://fumadocs-upload.any1.tech/download/edgeone-probe/1/md', {
        headers: { 'X-Internal-Key': 'a'.repeat(32) },
      }),
      params: { documentId: 'edgeone-probe', version: '1', format: 'md' },
      env: { DOWNLOAD_GATEWAY_SECRET: 'a'.repeat(32) },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    vi.doUnmock('@edgeone/pages-blob');
    vi.resetModules();
  });

  it('creates a versioned Blob key and gateway URL from a safe reference', () => {
    const reference = parseArtifactReference({
      documentId: 'message-abc_123',
      version: 3,
      format: 'pdf',
    });

    expect(artifactKey(reference)).toBe(
      'documents/message-abc_123/v3/document.pdf',
    );
    expect(buildDownloadGatewayUrl('https://blob.example.test/download', reference)).toBe(
      'https://blob.example.test/download/message-abc_123/3/pdf',
    );
  });

  it('rejects traversal and invalid artifact formats at the contract boundary', () => {
    expect(() =>
      parseArtifactReference({ documentId: '../private', version: 1, format: 'pdf' }),
    ).toThrow('Invalid document reference');
    expect(() =>
      parseArtifactReference({ documentId: 'message-1', version: 0, format: 'pdf' }),
    ).toThrow('Invalid document reference');
    expect(() =>
      parseArtifactReference({ documentId: 'message-1', version: 1, format: 'html' }),
    ).toThrow('Invalid document reference');
  });

  it('accepts the Unicode and slash characters used by AnyWorkflow history keys', () => {
    const entryKey = 'message:安装-A:e8e0c97d-5b24-40b3-b0ca-cb105929e8da:会话/42:2';
    expect(
      parseAnyWorkflowPublishTrigger({
        schemaVersion: 1,
        kind: 'message',
        messageRecordId: 'abc123456789012',
        entryKey,
        checksum: 'a'.repeat(64),
      }).entryKey,
    ).toBe(entryKey);
    expect(() =>
      parseAnyWorkflowPublishTrigger({
        schemaVersion: 1,
        kind: 'message',
        messageRecordId: 'abc123456789012',
        entryKey: 'message:task\nwith-control-character',
        checksum: 'a'.repeat(64),
      }),
    ).toThrow('Invalid document publish trigger');
  });

  it('accepts only a signer response for the exact requested key and MIME type', () => {
    const reference = parseArtifactReference({
      documentId: 'message-abc_123',
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
          key: 'documents/other/v3/document.md',
          uploadUrl: 'https://blob.example.test/upload/signed',
          contentType: 'text/markdown',
        },
        reference,
      ),
    ).toThrow('Invalid Blob signer response');
  });

  it('keeps the checked-in n8n workflow importable and secret-free', () => {
    const workflow = JSON.parse(
      readFileSync(new URL('../n8n/document-publish.workflow.json', import.meta.url), 'utf8'),
    ) as {
      id?: string;
      nodes: Array<{ name: string; parameters?: { jsCode?: string } }>;
      connections: object;
      settings?: { errorWorkflow?: string };
    };
    expect(workflow.id).toBe('document-publish-main-v1');
    expect(workflow.settings?.errorWorkflow).toBe('document-publish-error-v1');
    const names = new Set(workflow.nodes.map((node) => node.name));

    expect([...names]).toEqual(
      expect.arrayContaining([
        'Webhook',
        'Get PocketBase Message',
        'New API Metadata',
        'Prepare Document Write',
        'Write Document',
        'Merge Document Response',
        'Create mdTOpdf Job',
        'Upload mdTOpdf Markdown',
        'Mark mdTOpdf Uploaded',
        'Queue mdTOpdf Job',
        'Dispatch mdTOpdf Action',
        'Wait mdTOpdf Action',
        'Get mdTOpdf Job',
        'Download mdTOpdf PDF',
        'Select mdTOpdf PDF',
        'Sign Artifact Upload',
        'Put GitHub File',
        'Finalize PocketBase',
      ]),
    );
    expect(names).not.toContain('Render PDF');
    expect(names).not.toContain('Get mdTOpdf Input File');
    expect(names).not.toContain('Put mdTOpdf Markdown');
    expect(names).not.toContain('Decompress mdTOpdf Artifact');
    const workflowText = JSON.stringify(workflow);
    const dispatchCode = workflow.nodes.find((node) => node.name === 'Prepare mdTOpdf Dispatch')
      ?.parameters?.jsCode ?? '';
    expect(dispatchCode).toContain('job_id');
    const pollCode = workflow.nodes.find((node) => node.name === 'Parse mdTOpdf Job Status')
      ?.parameters?.jsCode ?? '';
    expect(workflowText).toContain('build-pdf-api.yml');
    expect(workflowText).toContain('workflow_dispatch');
    expect(workflowText).toContain('/rest/v1/pdf_jobs');
    expect(pollCode).toContain('mdToPdfReady');
    expect(pollCode).toContain('mdToPdfPollCount');
    const connections = workflow.connections as Record<string, { main: Array<Array<{ node: string }>> }>;
    expect(connections['Build Document']?.main?.[0]?.[0]?.node).toBe('Prepare Document Write');
    expect(connections['Merge Document Response']?.main?.[0]?.[0]?.node).toBe('Prepare mdTOpdf Input');
    expect(connections['Is mdTOpdf Ready']?.main?.[0]?.[0]?.node).toBe('Download mdTOpdf PDF');
    expect(connections['Is mdTOpdf Ready']?.main?.[1]?.[0]?.node).toBe('Wait mdTOpdf Action');
    expect(JSON.stringify(workflow)).not.toMatch(/(?:eyJ|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/u);
    for (const node of workflow.nodes) {
      const jsCode = node.parameters?.jsCode;
      if (jsCode) expect(() => new Function(jsCode)).not.toThrow();
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
    expect(workflow).not.toContain('md-to-pdf');
    expect(workflow).not.toMatch(/^\s*EDGEONE_API_TOKEN:\s*(?!\$\{\{)[^\s#]/mu);
  });

  it('places Node.js Blob handlers in EdgeOne cloud-functions routes', () => {
    const cloudFunctionsDir = new URL('../edgeone/cloud-functions/', import.meta.url);
    const legacyFunctionsDir = new URL('../edgeone/functions/', import.meta.url);

    expect(existsSync(cloudFunctionsDir)).toBe(true);
    expect(existsSync(new URL('api/blob/upload-url.js', cloudFunctionsDir))).toBe(true);
    expect(existsSync(new URL('download/[documentId]/[version]/[format].js', cloudFunctionsDir))).toBe(true);
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
});
