import { describe, expect, it } from 'vitest';
// @ts-expect-error The static build helpers are intentionally Node.js ESM scripts.
import { getStaticDocsConfig, shouldIncludeInStaticDocsProject } from '../scripts/static-docs-config.mjs';
// @ts-expect-error The static build helpers are intentionally Node.js ESM scripts.
import { getStaticMarkdownOutputPath, renderStaticMarkdown } from '../scripts/static-docs-markdown.mjs';
// @ts-expect-error The static search helpers are intentionally Node.js ESM scripts.
import {
  buildSearchRoutingTokens,
  buildZBSearchSectionIndexes,
  buildZBSearchSourceIndex,
  getSearchScope,
  sanitizeSearchText,
  ZBSEARCH_MAX_BYTES,
  ZBSEARCH_MAX_SECTION_CHARS,
  ZBSEARCH_SOFT_MAX_BYTES,
  ZBSEARCH_WARNING_BYTES,
} from '../scripts/zbsearch-index.mjs';

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

  it('builds section-aware ZBSearch source records without enabling remarkStructure globally', () => {
    const index = buildZBSearchSourceIndex(
      'math/example.mdx',
      [
        '---',
        'title: "示例章节"',
        'description: "用于测试静态搜索"',
        '---',
        '',
        '# 一阶标题',
        '',
        '矩阵相似对角化需要足够多的线性无关特征向量。',
        '',
        '## 二阶标题',
        '',
        '这里继续解释特征值与特征向量。',
      ].join('\n'),
    );

    expect(index.id).toBe('/docs/math/example');
    expect(index.url).toBe('/docs/math/example');
    expect(index.title).toBe('示例章节');
    expect(index.description).toBe('用于测试静态搜索');
    expect(index.category).toBe('math');
    expect(index.group).toBe('math/example');
    expect(index.structuredData.headings.length).toBeGreaterThan(0);
    expect(index.structuredData.contents.some((item) => item.content.includes('相似对角化'))).toBe(true);
  });

  it('strips low-value LaTeX while retaining natural-language search terms', () => {
    const text = sanitizeSearchText(
      '重要极限 $$\\lim_{x\\to 0} \\frac{\\sin x}{x}=1$$ 可用夹逼准则证明，并参考 https://example.com。',
    );

    expect(text).toContain('重要极限');
    expect(text).toContain('夹逼准则');
    expect(text).not.toContain('\\frac');
    expect(text).not.toContain('example.com');
  });

  it('builds deterministic routing tokens for Chinese and typo-tolerant Latin routing', () => {
    const chinese = buildSearchRoutingTokens('特征值');
    expect(chinese).toContain('c2:特征');
    expect(chinese).toContain('c2:征值');

    const latin = buildSearchRoutingTokens('pipeline');
    expect(latin).toContain('w:pipeline');
    expect(latin).toContain('g:pip');
    expect(latin).toContain('g:ine');
  });

  it('derives stable category and group scopes from documentation paths', () => {
    expect(getSearchScope('index.md')).toEqual({ category: 'root', group: 'root' });
    expect(getSearchScope('408/computer-networks/01-network.md')).toEqual({
      category: '408',
      group: '408/computer-networks',
    });
    expect(getSearchScope('math/advanced-mathematics/index.mdx')).toEqual({
      category: 'math',
      group: 'math/advanced-mathematics',
    });
  });

  it('chunks oversized section text behind the same heading URL', () => {
    const page = buildZBSearchSourceIndex(
      'math/large.mdx',
      [
        '---',
        'title: "长章节"',
        '---',
        '',
        '## 很长的正文',
        '',
        `矩阵${'特征值与特征向量'.repeat(ZBSEARCH_MAX_SECTION_CHARS)}`,
      ].join('\n'),
    );
    const records = buildZBSearchSectionIndexes(page);
    const headingRecords = records.filter((record) => record.url.includes('#'));

    expect(headingRecords.length).toBeGreaterThan(1);
    expect(new Set(headingRecords.map((record) => record.url)).size).toBe(1);
    expect(Math.max(...headingRecords.map((record) => Array.from(record.content).length))).toBeLessThanOrEqual(
      ZBSEARCH_MAX_SECTION_CHARS,
    );
  });

  it('keeps automatic shard guardrails safely below the EdgeOne single-file limit', () => {
    expect(ZBSEARCH_SOFT_MAX_BYTES).toBe(10_000_000);
    expect(ZBSEARCH_WARNING_BYTES).toBe(15_000_000);
    expect(ZBSEARCH_MAX_BYTES).toBe(25_000_000);
    expect(ZBSEARCH_SOFT_MAX_BYTES).toBeLessThan(ZBSEARCH_WARNING_BYTES);
    expect(ZBSEARCH_WARNING_BYTES).toBeLessThan(ZBSEARCH_MAX_BYTES);
  });
});
