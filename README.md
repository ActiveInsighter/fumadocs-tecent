# Fumadocs on EdgeOne

A minimal Fumadocs documentation site built with Next.js 16 and Tailwind CSS 4.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/docs`.

## ZBSearch

Documentation search uses Fumadocs' built-in ZBSearch engine and remains fully
static. No Algolia account, search API, Cloud Function, or Edge Function is
required.

The search build is intentionally tiered so the browser does not have to download
the full corpus as the documentation grows:

1. `/search-index.json` is a very small root manifest.
2. A lightweight global core index contains page titles, descriptions, and a
   bounded heading summary, so useful page results can appear first.
3. The root manifest points to content-addressed category router files (for
   example Math, 408, Politics). A normal query loads only the current or most
   likely categories.
4. Each category router contains compact Bloom-filter routing metadata for its
   full-text shards. The browser normally loads only a few body shards that are
   likely to contain the query.
5. If the lightweight results cannot identify a category, search progressively
   expands to more category routers instead of downloading the entire corpus at
   once.

Body indexes remain section-aware, so results can link directly to matching
heading anchors. Very long sections are split into bounded chunks behind the same
anchor and duplicate URLs are merged in the UI.

Before indexing, low-value search payload is removed: large LaTeX formula bodies,
URLs, MDX syntax, and duplicate section text do not consume the same space as
natural-language explanations. Fenced code blocks are already excluded by the
Fumadocs structured-data extractor. Search structure is generated independently
of the main MDX render pipeline, so the pure-static build can keep
`remarkStructure` disabled for page-build performance.

Sharding is automatic rather than fixed. Pages are grouped by documentation
category/subtree, then stable content-size partitions are created around a target
search payload. Any exported ZBSearch shard that still grows beyond the soft
limit is split again automatically. Generated core, router, and body files use
content hashes in their filenames, which lets unchanged search files keep stable
cache identities across deployments.

`npm run search:build` generates the same hierarchical search layout in `public/`
for local development. `npm run build:static-docs` generates it directly in the
EdgeOne deployment artifact and reports raw/gzip/Brotli sizes. The build has a
10 MB soft split target, warns at 15 MB, and rejects any individual static search
file at 25,000,000 bytes to stay below EdgeOne's single-file limit.

## Deployment

Production documentation deployments run in GitHub Actions and are uploaded to
Tencent EdgeOne Makers. The documentation package is a pure static CDN build:

- HTML, JS, CSS, Markdown downloads, the search manifest, category routers, and
  ZBSearch indexes are static files;
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
