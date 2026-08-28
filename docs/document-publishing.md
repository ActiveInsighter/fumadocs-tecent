# Automatic task document publishing

The publishing path is event-driven and task-scoped:

```text
AnyWorkflow task completed → PocketBase task tree
→ EdgeOne-hosted Fumadocs ingest API → n8n Workflow A (metadata)
→ n8n Workflow B (publish) → MDX pages + optional MD/PDF on EdgeOne Blob
→ one GitHub commit per publish job → EdgeOne build → Fumadocs site
```

The unit of publishing is a **task**. A task is only publishable when
`status=completed` and `metadataStatus=ready`. Messages are never published
individually.

The PocketBase message bodies are not copied into the browser notification.
The extension sends only the owner-scoped task record ID, checksum, and build
flags. The Fumadocs server validates the PocketBase session and forwards a
server-only key to n8n. n8n then reads the full task tree from PocketBase
with its server token.

## Components to deploy

1. Apply `pocketbase/pb_migrations/1787000000_document_publishing.js` and
   `pocketbase/pb_migrations/1788000000_task_publishing.js` to the
   AnyWorkflow PocketBase instance. The second migration adds
   `aw_publish_jobs`, `publishKey`/auto/manual metadata fields on
   `aw_tasks`/`aw_events`/`aw_acts`/`aw_messages`, and task/event/act/message
   kinds on `aw_documents`.
2. Configure the mdTOpdf Supabase project with the schema, private `pdf-jobs`
   bucket, and secrets required by
   `ActiveInsighter/md-to-pdf/.github/workflows/build-pdf-api.yml`. mdTOpdf is
   not deployed on either cloud server; n8n invokes that GitHub Action with a
   `job_id` per document, all jobs of one task dispatched concurrently.
3. Deploy `edgeone/cloud-functions` as EdgeOne Node.js Cloud Functions. The upload signer is
   `/api/blob/upload-url`; the download gateway is
   `/download/tasks/:taskRecordId/:version/:messageRecordId/:format`.
4. Import the three workflows from `n8n/` in this order:
   `task-publish-error.workflow.json` (shared Error Workflow),
   `task-metadata.workflow.json`, `task-document-publish.workflow.json`.
   Set the environment variables listed in the n8n README, including
   `N8N_WEBHOOK_URL` for the A→B trigger.
5. Configure the Fumadocs server variables in the EdgeOne `fumadocs-docs`
   project. The Fumadocs deployment must be able to reach PocketBase, n8n, and
   the EdgeOne signer/gateway; the browser never receives these secrets.
6. Build the extension with
   `VITE_FUMADOCS_DOCUMENT_INGEST_URL=https://<fumadocs-host>/api/integrations/anyworkflow`.
   This build-time public URL is added to the extension host permissions and
   CSP.

The n8n and EdgeOne endpoints currently verified for production are:

```text
n8n enrich webhook:    https://n8n.any1.tech/webhook/anyworkflow-task-enrich
n8n publish webhook:   https://n8n.any1.tech/webhook/anyworkflow-task-publish
EdgeOne Blob signer:   https://fumadocs-upload.any1.tech/api/blob/upload-url
EdgeOne Blob gateway:  https://fumadocs-upload.any1.tech/download
```

Set `FUMADOCS_BASE_URL` and `N8N_WEBHOOK_URL` on n8n to the stable EdgeOne /
n8n production hostnames before activating the workflows.

If you later attach custom domains, update these URL variables while keeping
the shared secrets unchanged.

## Publish job lifecycle

```text
Task completed (checksum)
→ Workflow A: metadataStatus pending → processing → ready
→ aw_publish_jobs v{next}: queued
→ Workflow B: snapshotting → building
   ├─ MDX pages (always)
   ├─ Markdown artifact (buildMd)
   └─ PDF jobs batch (buildPdf)
→ uploading → committing (one Git Data API commit)
→ published
```

A publish job with the same `sourceChecksum` already `published` is a no-op.
An in-flight job is ignored to prevent concurrent publishes. A failed job or
a changed checksum gets the next `version`.

## mdTOpdf job lifecycle

n8n uses the mdTOpdf Supabase REST and Storage APIs. For one task it creates
all `pdf_jobs` rows at once (each with `publish_job_id`), uploads every
`jobs/{uuid}/input.md`, advances them through `uploaded` and `queued`, then
dispatches the fixed GitHub Action per job:

```text
created → upload input.md → uploaded → queued
→ workflow_dispatch(job_id) → building/uploading → completed
→ download output.pdf
```

The Action reads the private Markdown object, renders it on a GitHub-hosted
runner, writes the PDF back to private Storage, and updates `pdf_jobs`. User
documents never enter the mdTOpdf Git repository, a Git commit, or a
long-lived GitHub artifact. n8n polls the whole batch with one query per
cycle; the loop is bounded and fails the publish job if any PDF fails or
times out.

## Version and idempotency rules

Artifacts use task-scoped, per-version keys:

```text
documents/tasks/<taskRecordId>/v{version}/messages/<messageRecordId>/document.md
documents/tasks/<taskRecordId>/v{version}/messages/<messageRecordId>/document.pdf
```

Pages use frozen `publishKey` paths (never re-generated AI slugs):

```text
content/docs/tasks/<taskPublishKey>/index.mdx
content/docs/tasks/<taskPublishKey>/events/<eventPublishKey>/index.mdx
content/docs/tasks/<taskPublishKey>/events/.../acts/<actPublishKey>/index.mdx
content/docs/tasks/<taskPublishKey>/events/.../acts/.../messages/<messagePublishKey>.mdx
```

`aw_publish_jobs` is keyed by `(task, version)`; `aw_documents` records carry
`publishJob`, `task`/`event`/`act`/`message`, `publishKey`, and
`fumadocsPath`; artifacts are keyed by `(publishJob, document, format)`.
Completed Blob uploads from a failed run are reused when the publish job is
retried, and an old version stays downloadable while a new one is generated.

## Failure handling

The extension outbox retries the notification if n8n or the server is
temporarily unavailable. n8n HTTP nodes are configured with retries. The
shared error workflow records:

- `aw_tasks.metadataStatus=failed` when enrichment fails,
- `aw_publish_jobs.status=failed` plus failed `aw_documents` for that job
  when publishing fails.

A failed publish job can be re-run without calling the metadata model again;
documents are only marked `published` after the GitHub commit succeeds, so a
partial publish is never visible.

Do not put PocketBase superuser credentials, n8n keys, New API keys, GitHub
tokens, mdTOpdf Supabase keys, or EdgeOne tokens in the extension,
`content/docs`, or this repository.
