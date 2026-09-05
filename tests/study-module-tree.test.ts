import { describe, expect, it } from 'vitest';
import type * as PageTree from 'fumadocs-core/page-tree';
import { source } from '@/lib/source';

function collectFolderUrls(folder: PageTree.Folder, output: Set<string>) {
  if (folder.index) output.add(folder.index.url);

  for (const child of folder.children) {
    if (child.type === 'page') output.add(child.url);
    else if (child.type === 'folder') collectFolderUrls(child, output);
  }
}

describe('study module page tree', () => {
  const tree = source.getPageTree();
  const roots = tree.children.filter(
    (node): node is PageTree.Folder => node.type === 'folder' && node.root === true,
  );

  it('contains exactly the four study roots and nothing else at top level', () => {
    expect(tree.children).toHaveLength(4);
    expect(roots.map((root) => root.$ref?.folder).sort()).toEqual(
      ['408', 'english', 'math', 'politics'].sort(),
    );
  });

  it('places the complete math-question-types subtree under the math root', () => {
    const mathRoot = roots.find((root) => root.$ref?.folder === 'math');
    expect(mathRoot).toBeDefined();

    const mathUrls = new Set<string>();
    collectFolderUrls(mathRoot!, mathUrls);

    const questionTypePages = source
      .getPages()
      .filter(
        (page) =>
          page.url === '/docs/math-question-types' ||
          page.url.startsWith('/docs/math-question-types/'),
      );

    expect(questionTypePages.length).toBeGreaterThan(1);
    for (const page of questionTypePages) {
      expect(mathUrls.has(page.url), `${page.url} must be inside the math root`).toBe(true);
    }
  });

  it('gives every documentation page exactly one study-root owner', () => {
    const owners = new Map<string, string[]>();

    for (const root of roots) {
      const rootPath = root.$ref?.folder;
      expect(rootPath).toBeTruthy();

      const urls = new Set<string>();
      collectFolderUrls(root, urls);
      for (const url of urls) {
        const list = owners.get(url) ?? [];
        list.push(rootPath!);
        owners.set(url, list);
      }
    }

    for (const page of source.getPages()) {
      expect(owners.get(page.url), `${page.url} (${page.path}) must have one root owner`).toHaveLength(1);
    }
  });
});
