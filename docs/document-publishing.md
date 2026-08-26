# Automatic document publishing

The publishing path is event-driven:

```text
AnyWorkflow → PocketBase message → EdgeOne-hosted Fumadocs ingest API → n8n
→ New API metadata → mdTOpdf GitHub Action → EdgeOne Blob
→ GitHub content/docs/*.mdx → EdgeOne build → Fumadocs page and download links
```

The PocketBase message body is not copied into the browser notification. The
extension sends only the owner-scoped message record ID, entry key, and
checksum. The Fumadocs server validates the PocketBase session and forwards a
server-only key to n8n. n8n then reads the message from PocketBase with its
server token.

## Components to deploy

1. Apply `pocketbase/pb_migrations/1787000000_document_publishing.js` to the
   AnyWorkflow PocketBase instance.
2. Configure the mdTOpdf Supabase project with the schema, private `pdf-jobs`
   bucket, and secrets required by
   `ActiveInsighter/md-to-pdf/.github/workflows/build-pdf-api.yml`. mdTOpdf is
   not deployed on either cloud server; n8n invokes that GitHub Action with a
   `job_id`.
3. Deploy `edgeone/functions` as EdgeOne Node Functions. The upload signer is
   `/api/blob/upload-url`; the download gateway is
   `/download/:documentId/:version/:format`.
4. Import `n8n/document-publish.workflow.json` into n8n, import
   `n8n/document-publish-error.workflow.json` as its Error Workflow, and set
   the environment variables listed in the n8n README.
5. Configure the Fumadocs server variables in the EdgeOne `fumadocs-docs`
   project. The Fumadocs deployment must be able to reach PocketBase, n8n, and
   the EdgeOne signer/gateway; the browser never receives these secrets.
6. Build the extension with
   `VITE_FUMADOCS_DOCUMENT_INGEST_URL=https://<fumadocs-host>/api/integrations/anyworkflow`.
   This build-time public URL is added to the extension host permissions and
   CSP.

The n8n and EdgeOne endpoints currently verified for production are:

```text
n8n webhook:          https://n8n.any1.tech/webhook/anyworkflow-document-publish
EdgeOne Blob signer:  https://fumadocs-upload.any1.tech/api/blob/upload-url
EdgeOne Blob gateway: https://fumadocs-upload.any1.tech/download
```

Set `FUMADOCS_BASE_URL` on n8n to the stable EdgeOne production hostname. The
latest successful EdgeOne run prints the project endpoint; use the project's
stable assigned domain or an attached custom domain before activating the
workflow.

If you later attach custom domains, update these URL variables while keeping
the shared secrets unchanged.

## mdTOpdf job lifecycle

n8n uses the mdTOpdf Supabase REST and Storage APIs:

```text
created → upload input.md → uploaded → queued
→ workflow_dispatch(job_id) → building/uploading → completed
→ download output.pdf
```

The Action reads the private Markdown object, renders it on a GitHub-hosted
runner, writes the PDF back to private Storage, and updates `pdf_jobs`. User
documents never enter the mdTOpdf Git repository, a Git commit, or a long-lived
GitHub artifact. The n8n polling loop is bounded at 27 minutes and fails the
document workflow if the job fails or times out.

## Version and idempotency rules

Artifacts use:

```text
documents/{documentId}/v{version}/document.md
documents/{documentId}/v{version}/document.pdf
```

`aw_documents` is keyed by `(owner, documentId)`, and artifacts are keyed by
`(document, version, format)`. The n8n workflow treats an already-published or
currently-processing matching checksum as a no-op, preventing concurrent
uploads. A failed matching checksum can be rerun with the same version. A new
checksum gets the next version. The old version remains downloadable while
the new version is being generated; the document record is moved to
`published` only after both Blob uploads and the GitHub commit succeed.

## Failure handling

The extension outbox retries the notification if n8n or the server is
temporarily unavailable. n8n HTTP nodes are configured with retries. A failed
workflow should be visible in n8n and can be re-run with the same event after
fixing the failed component. The error workflow records `status=failed` on the
processing document before the next retry.

Do not put PocketBase superuser credentials, n8n keys, New API keys, GitHub
tokens, mdTOpdf Supabase keys, or EdgeOne tokens in the extension,
`content/docs`, or this repository.
