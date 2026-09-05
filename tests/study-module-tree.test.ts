import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const docsRoot = join(process.cwd(), 'content', 'docs');

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('study module metadata structure', () => {
  const rootMeta = readJson(join(docsRoot, 'meta.json'));
  const mathMeta = readJson(join(docsRoot, 'math', 'meta.json'));

  it('exposes exactly four root modules from the documentation root', () => {
    expect(rootMeta.pages).toEqual(['politics', 'english', 'math', '408']);

    const rootDirectories = readdirSync(docsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(rootDirectories).toEqual(
      ['408', 'english', 'math', 'math-question-types', 'politics'].sort(),
    );
  });

  it('attaches math-question-types through the math root using Fumadocs native relative ownership', () => {
    expect(mathMeta.root).toBe(true);
    expect(mathMeta.pages).toEqual([
      'index',
      'advanced-mathematics',
      'linear-algebra',
      'probability-statistics',
      '../math-question-types',
    ]);
  });

  it('keeps math-question-types itself as a normal nested folder, not another root module', () => {
    const questionTypesMeta = readJson(join(docsRoot, 'math-question-types', 'meta.json'));
    expect(questionTypesMeta.root).not.toBe(true);
    expect(questionTypesMeta.title).toBe('数学真题题型总结');
  });
});
