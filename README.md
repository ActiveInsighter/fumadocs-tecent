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
The production build generates a standalone `/search-index.json` file and the
browser downloads it on first search, then performs subsequent queries locally.
No Algolia account, API key, server-side search endpoint, Cloud Function, or Edge
Function is required.

The pure-static build keeps `remarkStructure` disabled in the main Fumadocs MDX
pipeline for build performance. Search structure is generated independently by
`scripts/zbsearch-index.mjs`, so enabling search does not undo that optimization.

`npm run build:static-docs` reports the raw, gzip, and Brotli sizes of the index.
The build warns once the raw index reaches 15 MB and fails at 25,000,000 bytes to
stay below EdgeOne's 25 MB single-file limit.

## Deployment

Production documentation deployments run in GitHub Actions and are uploaded to
Tencent EdgeOne Makers. The documentation package is a pure static CDN build:

- HTML, JS, CSS, Markdown downloads, and `/search-index.json` are static files;
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
