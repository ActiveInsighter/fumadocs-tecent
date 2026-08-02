# fumadocs-vercel

A minimal Fumadocs documentation site built with Next.js 16 and Tailwind CSS 4.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/docs`.

## Deployment

Deployments are built in GitHub Actions and uploaded to Vercel as prebuilt output:

- pushes to `main` use Vercel **Production** environment variables and update the production deployment;
- pushes to any other branch use Vercel **Preview** environment variables and create a preview deployment;
- Vercel Git-triggered builds are disabled in `vercel.json` to avoid duplicate builds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Each deployment run uploads a `workflow-run-<run-id>` artifact containing the current run ID and the latest workflow run metadata.
