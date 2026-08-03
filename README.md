# fumadocs-vercel

A minimal Fumadocs documentation site built with Next.js 16 and Tailwind CSS 4.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/docs`.

## Deployment

GitHub Actions runs one shared validation stage and then starts two independent
deployment jobs in parallel:

- **Vercel** pulls the matching Vercel environment, builds with Vercel CLI, and
  uploads the prebuilt output with `vercel deploy --prebuilt`.
- **EdgeOne Makers** installs EdgeOne CLI and runs `edgeone makers deploy`
  without an output-directory argument, so the EdgeOne CLI builds the complete
  Next.js application in the GitHub runner and uploads the generated `.edgeone`
  deployment.

Deployment environments are selected from the Git branch:

- pushes to `main` deploy both platforms to **production**;
- pushes to any other branch deploy both platforms to **preview**;
- manual runs follow the same branch-based environment rule.

Vercel Git-triggered builds remain disabled in `vercel.json` to avoid duplicate
Vercel builds.

The existing EdgeOne project named by `EDGEONE_PROJECT_NAME` is Git-connected,
which cannot receive direct CLI uploads. The workflow preserves that project and
uses `<EDGEONE_PROJECT_NAME>-upload` as its dedicated Upload-provider project.
The Upload project was initialized with a production deployment during workflow
validation, so subsequent branch runs can deploy directly to preview.

`edgeone.json` makes the EdgeOne build deterministic by pinning Node.js 22.11.0
and explicitly setting `npm ci --no-audit --no-fund` and `npm run build` as the
install and build commands. EdgeOne CLI is pinned in the workflow as well.

### Required GitHub Actions configuration

Secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `EDGEONE_API_TOKEN`

Repository variable:

- `EDGEONE_PROJECT_NAME`

Each workflow run uploads start and completion metadata artifacts named
`workflow-run-<run-id>-<phase>`. The workflow summary reports the shared checks,
Vercel deployment, EdgeOne Makers deployment, the actual EdgeOne Upload project,
and the combined result. EdgeOne preview authentication tokens are redacted from
workflow logs and summaries.
