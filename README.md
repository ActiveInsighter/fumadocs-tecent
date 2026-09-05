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

The search layout is designed so query cost does not grow linearly with the full
document corpus:

1. `/search-index.json` is the only stable search URL. It contains a bounded
   Bloom-filter summary for each top-level documentation category and points to
   content-addressed category router files.
2. The browser scores those tiny category summaries using the current query and
   current documentation location. It normally loads only the most likely one or
   two category routers first.
3. Each category router contains Bloom routing metadata for two independent
   ZBSearch tiers: lightweight `core` shards (page title, description, bounded
   heading summary) and full-text `body` shards.
4. The browser loads a small routed core batch first so page-level results appear
   quickly, then a small routed body batch for exact heading/full-text matches.
5. If there are not enough results, search expands progressively. A hard per-query
   budget caps category routers, core shards, and body shards, so even a very
   large future category cannot force the browser to download the whole index.

Both core and body storage are automatically sharded. This matters at large
scale: even the lightweight page index is never treated as one global file that
must be downloaded in full. Corpus growth primarily creates more immutable
static shards rather than proportionally increasing every user's first-search
payload.

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
content hashes in their filenames, which lets unchanged files keep stable browser
and CDN cache identities across deployments.

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
