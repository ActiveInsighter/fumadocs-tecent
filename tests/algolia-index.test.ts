import { describe, expect, it } from 'vitest';
// @ts-expect-error The indexing helper is an intentionally Node.js ESM script.
import { buildAlgoliaDocument } from '../scripts/algolia-index.mjs';

describe('buildAlgoliaDocument', () => {
  it('creates a section-aware Fumadocs Algolia document from MDX', () => {
    const document = buildAlgoliaDocument(
      'politics/example.mdx',
      [
        '---',
        'title: "唯物辩证法"',
        'description: "马克思主义基本原理中的重要方法。"',
        '---',
        '',
        '## 对立统一规律',
        '',
        '矛盾双方既对立又统一。',
      ].join('\n'),
    );

    expect(document).toMatchObject({
      _id: '/docs/politics/example',
      title: '唯物辩证法',
      description: '马克思主义基本原理中的重要方法。',
      url: '/docs/politics/example',
    });
    expect(document.structured.headings).toEqual([
      { id: '对立统一规律', content: '对立统一规律' },
    ]);
    expect(document.structured.contents).toEqual([
      { heading: '对立统一规律', content: '矛盾双方既对立又统一。' },
    ]);
  });

  it('uses a stable path-derived title when frontmatter has no title', () => {
    const document = buildAlgoliaDocument(
      'math/linear-algebra/02-matrices.md',
      '正文内容',
    );

    expect(document.title).toBe('02-matrices');
    expect(document.url).toBe('/docs/math/linear-algebra/02-matrices');
  });

  it('keeps valid Markdown comparisons that are not valid MDX JSX', () => {
    const document = buildAlgoliaDocument(
      '408/example.md',
      ['## 比较', '', '| 条件 | 结果 |', '| --- | --- |', '| A<B | 真 |'].join('\n'),
    );

    expect(document.structured.contents).toContainEqual(
      expect.objectContaining({ content: expect.stringContaining('A<B') }),
    );
  });
});
