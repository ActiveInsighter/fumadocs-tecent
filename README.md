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
  without an output-directory argument, so the EdgeOne CLI builds the Next.js
  project in the GitHub runner and uploads the resulting deployment.

Deployment environments are selected from the Git branch:

- pushes to `main` deploy both platforms to **production**;
- pushes to any other branch deploy both platforms to **preview**;
- manual runs follow the same branch-based environment rule.

Vercel Git-triggered builds remain disabled in `vercel.json` to avoid duplicate
Vercel builds. The EdgeOne project should use the direct-upload deployment type,
because GitHub Actions and the EdgeOne CLI own its build and upload process.

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
Vercel deployment, EdgeOne Makers deployment, and the combined result.
