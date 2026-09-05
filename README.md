# Fumadocs on EdgeOne

A minimal Fumadocs documentation site built with Next.js 16 and Tailwind CSS 4.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/docs`.

## ZBSearch

Documentation search uses Fumadocs' built-in ZBSearch engine in static mode.
The production build generates a small `/search-index.json` manifest plus three
static ZBSearch shards (`/search-index-0.json` through `/search-index-2.json`).
The browser loads the manifest and shards on first search, then performs all
queries locally. No Algolia account, API key, server-side search endpoint, Cloud
Function, or Edge Function is required.

To keep the index compact while preserving useful deep links, the build creates
one ZBSearch record per page/heading section instead of one record per paragraph.
Results can still point directly to the matching heading anchor. The three shards
are deterministically distributed by page URL so adding a document does not
reshuffle the entire search corpus.

The pure-static build keeps `remarkStructure` disabled in the main Fumadocs MDX
pipeline for build performance. Search structure is generated independently by
`scripts/zbsearch-index.mjs`, so enabling search does not undo that optimization.

`npm run build:static-docs` reports raw, gzip, and Brotli estimates for every
shard and for the full index. Each shard warns at 15 MB and the build fails if any
single shard reaches 25,000,000 bytes, matching EdgeOne's single-file limit.

## Deployment

Production documentation deployments run in GitHub Actions and are uploaded to
Tencent EdgeOne Makers. The documentation package is a pure static CDN build:

- HTML, JS, CSS, Markdown downloads, the search manifest, and all ZBSearch shards
  are static files;
- documentation search runs in the browser with ZBSearch;
- Cloud Functions: 0;
- Edge Functions: 0.

The separate `fumadocs-upload` project still hosts the private Blob signer and
download gateway functions used by the document publishing workflow.

Required GitHub Actions secrets:

- `EDGEONE_API_TOKEN`
- `EDGEONE_INTERNAL_API_KEY`
- `EDGEONE_DOWNLOAD_GATEWAY_SECRET`
- `N8N_DOCUMENT_PUBLISH_SECRET`
- `FUMADOCS_BLOB_UPLOAD_KEY`

Required GitHub Actions variables:

- `EDGEONE_PROJECT_NAME` — the existing Upload-provider project for Blob
  functions (`fumadocs-upload`);
- `EDGEONE_DOCS_PROJECT_NAME` — the Upload-provider project for the pure static
  documentation site (`fumadocs-docs`).

Do not commit any secret values. Runtime secrets are written to the relevant
EdgeOne project by CI and are never exposed to the browser.
