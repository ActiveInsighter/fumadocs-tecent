# Fumadocs on EdgeOne

A minimal Fumadocs documentation site built with Next.js 16 and Tailwind CSS 4.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/docs`.

## Deployment

Production documentation deployments run in GitHub Actions and are uploaded to
Tencent EdgeOne Makers. The repository uses two direct-upload projects:

- `fumadocs-docs` hosts the complete Next.js/Fumadocs application, including the
  server-side integration routes;
- `fumadocs-upload` hosts the private Blob signer and download gateway functions.

`edgeone.json` pins the install command, build command, and Node.js version used
by the EdgeOne build. Both workflows deploy only after validating their API
token and project variable.

Required GitHub Actions secrets:

- `EDGEONE_API_TOKEN`
- `EDGEONE_INTERNAL_API_KEY`
- `EDGEONE_DOWNLOAD_GATEWAY_SECRET`
- `N8N_DOCUMENT_PUBLISH_SECRET`
- `FUMADOCS_BLOB_UPLOAD_KEY`

Required GitHub Actions variables:

- `EDGEONE_PROJECT_NAME` — the existing Upload-provider project for Blob
  functions (`fumadocs-upload`);
- `EDGEONE_DOCS_PROJECT_NAME` — the Upload-provider project for the site
  (`fumadocs-docs`).

Do not commit any of these secret values. Runtime variables are written to the
EdgeOne project by CI and are never exposed to the browser.
