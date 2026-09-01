import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('docs deployment footprint', () => {
  it('renders document pages on demand instead of prerendering every document', () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), 'app/docs/[[...slug]]/page.tsx'),
      'utf8',
    );

    expect(routeSource).not.toMatch(/export function generateStaticParams\s*\(/u);
  });
});
