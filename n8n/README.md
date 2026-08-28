# n8n task document publishing workflows

Publishing is split into two task-level workflows. The unit of publishing is a
**task**, not a single message: one completed AnyWorkflow task becomes one
publish job, one set of MDX pages, and exactly one GitHub commit.

```text
Task completed
  → Workflow A: Task Metadata Enrichment   (webhook/anyworkflow-task-enrich)
      Message → Act → Event → Task metadata, bottom-up
      Creates aw_publish_jobs (queued)
  → Workflow B: Task Document Publish      (webhook/anyworkflow-task-publish)
      Snapshot → MDX → optional MD/PDF artifacts → Blob → single commit
```

Import order:

1. `task-publish-error.workflow.json` — shared Error Workflow.
2. `task-metadata.workflow.json` — Workflow A.
3. `task-document-publish.workflow.json` — Workflow B.

Leave both inactive until the environment variables are configured, then
activate. The webhook URLs are:

```text
POST https://<n8n-host>/webhook/anyworkflow-task-enrich
POST https://<n8n-host>/webhook/anyworkflow-task-publish
```

The Fumadocs server sends `X-Internal-Key`; the first Code node of each
workflow compares it with `N8N_DOCUMENT_PUBLISH_SECRET`. Workflow A triggers
Workflow B through `N8N_WEBHOOK_URL` (`WEBHOOK_URL` fallback) plus the same
secret, so the publish job can also be re-run manually.

## n8n environment variables

`compose.document-publishing.override.yml` is a secret-free Compose override
for the existing `/opt/n8n/compose.yml`. Copy it beside that file and start
n8n with both Compose files; provide the values through the host's existing
`.env` without printing or committing that file.

| Variable | Purpose |
| --- | --- |
| `N8N_DOCUMENT_PUBLISH_SECRET` | Matches Fumadocs `N8N_DOCUMENT_PUBLISH_SECRET`; also guards the A→B trigger. |
| `N8N_WEBHOOK_URL` | Public n8n origin used by Workflow A to call Workflow B, for example `https://n8n.any1.tech`. |
| `POCKETBASE_URL` | PocketBase origin, for example `https://pb.any1.tech`. |
| `POCKETBASE_SERVER_TOKEN` | Server-only PocketBase superuser/service token. |
| `NEW_API_BASE_URL` | Aliyun New API OpenAI-compatible origin. |
| `NEW_API_MODEL` | Model used for metadata JSON. |
| `NEW_API_API_KEY` | Server-only New API key. |
| `FUMADOCS_BASE_URL` | Public Fumadocs origin. |
| `FUMADOCS_BLOB_UPLOAD_KEY` | Matches Fumadocs `FUMADOCS_BLOB_UPLOAD_KEY`. |
| `GITHUB_OWNER` | Fumadocs repository owner, normally `ActiveInsighter`. |
| `GITHUB_REPO` | Fumadocs repository name, normally `fumadocs-tecent`. |
| `GITHUB_BRANCH` | Fumadocs publish branch, normally `main`. |
| `GITHUB_TOKEN` | Fine-grained token with Contents: write on the Fumadocs repository and Actions: write on the mdTOpdf repository. |
| `MDTO_PDF_SUPABASE_URL` | Supabase project URL used by the mdTOpdf repository. |
| `MDTO_PDF_SUPABASE_SERVICE_KEY` | Server-only Supabase secret key (`sb_secret_...`) or legacy service-role JWT. |
| `MDTO_PDF_SUPABASE_USER_ID` | UUID of the mdTOpdf Supabase Auth user that owns n8n-created jobs. |
| `MDTO_PDF_SUPABASE_BUCKET` | Private Storage bucket used by mdTOpdf; defaults to `pdf-jobs`. |
| `MDTO_PDF_THEME` | Renderer theme; defaults to `chatgpt-light`. |

The mdTOpdf repository, workflow, and branch are intentionally fixed in the
workflow source:

```text
ActiveInsighter/md-to-pdf
main
.github/workflows/build-pdf-api.yml
```

The workflows use `$env.*` in Code and HTTP Request nodes. If the n8n install
blocks environment access inside nodes, set
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` according to the n8n deployment policy.
Set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` so the downloaded PDFs are not
kept in process memory longer than necessary. Do not put any secret values
into the exported JSON.

## Workflow A — Task Metadata Enrichment

- The webhook body is the deterministic task envelope from Fumadocs:
  `taskRecordId`, `checksum`, `buildMd`, `buildPdf`. The task owner is checked
  against the event owner before anything is generated.
- A publish job with the same `sourceChecksum` in status `published` is a
  no-op (`duplicate accepted`). An in-flight job (queued → committing) is also
  ignored to prevent concurrent publishes. A failed job or a new checksum gets
  the next `version`.
- Metadata is generated bottom-up: every Message first (title / slug /
  summary / tags / publishKey), then Acts from their message summaries, then
  Events from act summaries, finally the Task. Long chat bodies are never sent
  more than once.
- `publishKey` is frozen on first generation. Later metadata reruns may change
  `autoTitle`, but the page path `content/docs/tasks/<taskPublishKey>/...`
  stays stable, so URLs, GitHub files, and Blob keys never drift.
- Records with `metadataMode=manual` keep their user-edited title/summary;
  AI reruns do not overwrite them.
- On success the task becomes `metadataStatus=ready`, an `aw_publish_jobs`
  row is created with `status=queued`, and Workflow B is triggered.

## Workflow B — Task Document Publish

- The publish job is locked (`snapshotting`), and the whole tree
  Task → Event → Act → Message is snapshotted once. Later database edits do
  not affect this publish run.
- One MDX page per Message plus `index.mdx` for each Task / Event / Act, and
  `meta.json` sidebars, all under
  `content/docs/tasks/<taskPublishKey>/events/<eventPublishKey>/acts/<actPublishKey>/messages/<messagePublishKey>.mdx`.
- `buildMd` / `buildPdf` are independent flags. MDX pages are always built;
  MD and PDF are optional downloadable artifacts.
- PDF jobs are created for the whole task at once, each with
  `publish_job_id`, then dispatched concurrently (batch of 5) to the fixed
  `build-pdf-api.yml` Action. n8n polls the batch through one query instead
  of one loop per document.
- Artifacts are uploaded to
  `documents/tasks/<taskId>/v<version>/messages/<messageId>/document.<md|pdf>`
  so every publish version is isolated and reruns reuse completed uploads.
- GitHub receives exactly one commit per publish job through the Git Data API
  (blobs → one tree → one commit → ref update). No per-file Contents commits.
- Documents and artifacts are marked `published`, and the publish job becomes
  `published`, only after the GitHub commit succeeds — a partial publish is
  never visible.

## Error workflow

`task-publish-error.workflow.json` is shared by both workflows. It inspects
the failed execution, then:

- Workflow A failure after `Lock Metadata` and before a publish job exists →
  `aw_tasks.metadataStatus=failed`.
- Any failure with a `publishJobId` → `aw_publish_jobs.status=failed`, and
  processing `aw_documents` records for that job become `failed` with a
  bounded `lastError`.

Both workflows save error execution data and can be safely re-run with the
same event after fixing the failed component. Re-running the publish job does
not call the metadata model again.
