import { describe, expect, it } from 'vitest';
// @ts-expect-error The static build helpers are intentionally Node.js ESM scripts.
import { getStaticDocsConfig, shouldIncludeInStaticDocsProject } from '../scripts/static-docs-config.mjs';
// @ts-expect-error The static build helpers are intentionally Node.js ESM scripts.
import { getStaticMarkdownOutputPath, renderStaticMarkdown } from '../scripts/static-docs-markdown.mjs';

describe('static docs build', () => {
  it('uses a pure static export with Turbopack build caching enabled', () => {
    const config = getStaticDocsConfig();

    expect(config.output).toBe('export');
    expect(config.trailingSlash).toBe(true);
    expect(config.rewrites).toBeUndefined();
    expect(config.headers).toBeUndefined();
    expect(config.experimental?.turbopackFileSystemCacheForBuild).toBe(true);
  });

  it('keeps documentation sources but excludes dynamic application routes', () => {
    expect(shouldIncludeInStaticDocsProject('content/docs/math/index.mdx')).toBe(true);
    expect(shouldIncludeInStaticDocsProject('app/docs/[[...slug]]/page.tsx')).toBe(true);
    expect(shouldIncludeInStaticDocsProject('app/download/tasks/[id]/route.ts')).toBe(false);
    expect(shouldIncludeInStaticDocsProject('app/llms.mdx/docs/[[...slug]]/route.ts')).toBe(false);
  });

  it('excludes all API routes from the pure static package', () => {
    expect(shouldIncludeInStaticDocsProject('app/api')).toBe(false);
    expect(shouldIncludeInStaticDocsProject('app/api/search')).toBe(false);
    expect(shouldIncludeInStaticDocsProject('app/api/search/route.ts')).toBe(false);
    expect(shouldIncludeInStaticDocsProject('app/api/upload/route.ts')).toBe(false);
  });

  it('maps source pages to stable direct markdown URLs', () => {
    expect(getStaticMarkdownOutputPath('index.md')).toBe('docs.md');
    expect(getStaticMarkdownOutputPath('math/index.mdx')).toBe('docs/math.md');
    expect(
      getStaticMarkdownOutputPath(
        'math/advanced-mathematics/01-limits-continuity.mdx',
      ),
    ).toBe('docs/math/advanced-mathematics/01-limits-continuity.md');
  });

  it('renders clean markdown without frontmatter or MDX-only imports', async () => {
    const markdown = await renderStaticMarkdown(
      `---\ntitle: "极限与连续"\n---\n\nimport Demo from './Demo'\n\n$$x^2$$`,
      { title: '极限与连续', url: '/docs/math/advanced-mathematics/01-limits-continuity' },
    );

    expect(markdown).toContain('# 极限与连续 (/docs/math/advanced-mathematics/01-limits-continuity)');
    expect(markdown).toContain('$$x^2$$');
    expect(markdown).not.toContain("import Demo");
    expect(markdown).not.toContain('title:');
  });

  it('keeps import statements that live inside fenced code blocks', async () => {
    const markdown = await renderStaticMarkdown(
      [
        'Intro',
        '',
        '```js',
        'import { useState } from "react";',
        '```',
        '',
        'import Gone from "./gone"',
        '',
        'Tail',
      ].join('\n'),
      { title: '示例', url: '/docs/example' },
    );

    expect(markdown).toContain('import { useState } from "react";');
    expect(markdown).not.toContain('./gone');
    expect(markdown).toContain('Tail');
  });
});
