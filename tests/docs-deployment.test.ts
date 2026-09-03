import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The deployment helper is intentionally a Node.js ESM script.
import {
  pruneStaticSegmentFiles,
  pruneUnusedImageOptimizerPackages,
} from '../scripts/prune-edgeone-prerendered.mjs';

describe('docs deployment footprint', () => {
  it('prerenders every content route and rejects unknown runtime paths', () => {
    const contentRoutes = [
      'app/docs/[[...slug]]/page.tsx',
      'app/(home)/blog/[[...slug]]/page.tsx',
      'app/llms.mdx/docs/[[...slug]]/route.ts',
    ];

    for (const route of contentRoutes) {
      const routeSource = readFileSync(resolve(process.cwd(), route), 'utf8');

      expect(routeSource, route).toMatch(/export function generateStaticParams\s*\(/u);
      expect(routeSource, route).toMatch(/generateParams\(\);/u);
      expect(routeSource, route).toMatch(/export const dynamicParams = false;/u);
    }
  });

  it('prunes prerendered files duplicated inside the EdgeOne SSR bundle', () => {
    const workflowSource = readFileSync(
      resolve(process.cwd(), '.github/workflows/deploy-edgeone-docs.yml'),
      'utf8',
    );

    expect(workflowSource).toMatch(/node scripts\/prune-edgeone-prerendered\.mjs/u);
  });

  it('removes static Next segment trees without removing flat route output', async () => {
    const serverAppDir = await mkdtemp(resolve(tmpdir(), 'fumadocs-edgeone-segments-'));
    const segmentFiles = [
      'docs/math/01-limits.segments/_full.segment.rsc',
      'docs/math/01-limits.segments/docs/$oc$slug/__PAGE__.segment.rsc',
    ];
    const flatRouteFile = 'docs/math/01-limits.rsc';

    try {
      for (const file of [...segmentFiles, flatRouteFile]) {
        const filePath = resolve(serverAppDir, file);
        await mkdir(resolve(filePath, '..'), { recursive: true });
        await writeFile(filePath, file);
      }

      const result = await pruneStaticSegmentFiles({ serverAppDir });

      expect(result.removedCount).toBe(segmentFiles.length);
      for (const file of segmentFiles) {
        await expect(access(resolve(serverAppDir, file))).rejects.toThrow();
      }
      await expect(access(resolve(serverAppDir, flatRouteFile))).resolves.toBeUndefined();
    } finally {
      await rm(serverAppDir, { recursive: true, force: true });
    }
  });

  it('uses the current EdgeOne CLI for the static docs deployment', () => {
    const workflowSource = readFileSync(
      resolve(process.cwd(), '.github/workflows/deploy-edgeone-docs.yml'),
      'utf8',
    );

    expect(workflowSource).toMatch(/EDGEONE_CLI_VERSION: 1\.6\.31-3/u);
  });

  it('disables the unused Next.js image optimizer for the docs app', () => {
    const nextConfigSource = readFileSync(
      resolve(process.cwd(), 'next.config.mjs'),
      'utf8',
    );

    expect(nextConfigSource).toMatch(/images:\s*\{[\s\S]*unoptimized:\s*true/u);
  });

  it('removes optional image optimizer packages from the SSR bundle', async () => {
    const serverRoot = await mkdtemp(resolve(tmpdir(), 'fumadocs-edgeone-'));
    const packageFiles = [
      'node_modules/sharp/index.js',
      'node_modules/@img/sharp-wasm32/index.js',
      'node_modules/@img/sharp-win32-x64/index.js',
    ];

    try {
      for (const file of packageFiles) {
        const filePath = resolve(serverRoot, file);
        await mkdir(resolve(filePath, '..'), { recursive: true });
        await writeFile(filePath, 'unused');
      }

      const result = await pruneUnusedImageOptimizerPackages({ serverRoot });

      expect(result.removedCount).toBe(3);
      for (const file of packageFiles) {
        await expect(access(resolve(serverRoot, file))).rejects.toThrow();
      }
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it('checks static HTML compression and EdgeOne cache status after deployment', () => {
    const workflowSource = readFileSync(
      resolve(process.cwd(), '.github/workflows/deploy-edgeone-docs.yml'),
      'utf8',
    );

    expect(workflowSource).toContain('Accept-Encoding: br, gzip');
    expect(workflowSource).toContain('Content-Encoding');
    expect(workflowSource).toContain('EO-Cache-Status');
    expect(workflowSource).toContain('static_docs_warmup_status');
  });
});
