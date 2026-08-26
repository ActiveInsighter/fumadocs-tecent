# EdgeOne Blob Functions

These Node Functions are the storage adapter for document artifacts. Deploy the
`edgeone/functions` directory with EdgeOne Makers and install the dependency in
`edgeone/package.json`.

Routes:

- `POST /api/blob/upload-url` — signs a short-lived PUT URL for `md` or `pdf`.
- `GET /download/:documentId/:version/:format` — streams a private artifact.

Configure these EdgeOne environment variables without committing their values:

- `INTERNAL_API_KEY`: shared with the Fumadocs server as `BLOB_SIGNER_SECRET`.
- `DOWNLOAD_GATEWAY_SECRET`: shared with the Fumadocs server as `BLOB_DOWNLOAD_GATEWAY_SECRET`.

The Blob store name is fixed to `document-artifacts`; create or select that store
in the EdgeOne project before deploying.
