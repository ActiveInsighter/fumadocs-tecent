# EdgeOne Blob Functions

These Node.js Cloud Functions are the storage adapter for document artifacts.
The handlers live under `edgeone/cloud-functions/api`, which is the directory
layout recognized by EdgeOne Makers for Node.js functions. Deploy the
`edgeone` package root with EdgeOne Makers and install the dependency in
`edgeone/package.json`.

Routes:

- `POST /api/blob/upload-url` — signs a short-lived PUT URL for `md` or `pdf`.
- `GET /download/:documentId/:version/:format` — streams a private artifact.

Configure these EdgeOne environment variables without committing their values:

- `INTERNAL_API_KEY`: shared with the Fumadocs server as `BLOB_SIGNER_SECRET`.
- `DOWNLOAD_GATEWAY_SECRET`: shared with the Fumadocs server as `BLOB_DOWNLOAD_GATEWAY_SECRET`.

The Blob store name is fixed to `document-artifacts`; create or select that store
in the EdgeOne project before deploying.

The repository workflow `.github/workflows/deploy-edgeone-functions.yml` deploys
only this package root to the direct-upload project named by the GitHub Actions
variable `EDGEONE_PROJECT_NAME`. It runs on changes under `edgeone/` or by
manual dispatch and reads `EDGEONE_API_TOKEN` from GitHub Actions Secrets.
