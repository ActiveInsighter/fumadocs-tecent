import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
