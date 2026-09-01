import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('docs deployment footprint', () => {
  it('prerenders every document page and rejects unknown runtime paths', () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), 'app/docs/[[...slug]]/page.tsx'),
      'utf8',
    );

    expect(routeSource).toMatch(/export function generateStaticParams\s*\(/u);
    expect(routeSource).toMatch(
      /return source\.generateParams\(\);/u,
    );
    expect(routeSource).toMatch(/export const dynamicParams = false;/u);
  });
});
