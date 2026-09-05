import { blog, docs } from 'collections/server';
import type * as PageTree from 'fumadocs-core/page-tree';
import { loader } from 'fumadocs-core/source';
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server';

const conciseMathModuleTitle = /^(?:高等数学|线性代数|概率论与数理统计)\s*模块\s*(\d+)\s*[：:]\s*(.+)$/u;

const EXPECTED_STUDY_ROOTS = ['politics', 'english', 'math', '408'] as const;

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: ({ typedPlugin }) => [
    typedPlugin({
      name: 'concise-math-question-type-sidebar',
      transformPageTree: {
        file(node) {
          if (
            node.type === 'page' &&
            typeof node.url === 'string' &&
            node.url.startsWith('/docs/math-question-types/') &&
            typeof node.name === 'string'
          ) {
            node.name = node.name.replace(conciseMathModuleTitle, '模块$1：$2');
          }
          return node;
        },
      },
    }),
  ],
});

function collectFolderPageUrls(folder: PageTree.Folder, output: Set<string>) {
  if (folder.index) output.add(folder.index.url);

  for (const child of folder.children) {
    if (child.type === 'page') {
      output.add(child.url);
    } else if (child.type === 'folder') {
      collectFolderPageUrls(child, output);
    }
  }
}

function assertStudyModuleTree() {
  const tree = source.getPageTree();
  const roots = tree.children.filter(
    (node): node is PageTree.Folder => node.type === 'folder' && node.root === true,
  );

  const rootByPath = new Map(
    roots.map((root) => [root.$ref?.folder ?? '', root] as const),
  );
  const actualRootPaths = Array.from(rootByPath.keys()).sort();
  const expectedRootPaths = [...EXPECTED_STUDY_ROOTS].sort();

  if (
    tree.children.length !== EXPECTED_STUDY_ROOTS.length ||
    actualRootPaths.join('\u0000') !== expectedRootPaths.join('\u0000')
  ) {
    throw new Error(
      `[study-modules] Invalid top-level Page Tree. Expected only ${expectedRootPaths.join(', ')}, got ${actualRootPaths.join(', ') || '(none)'}.`,
    );
  }

  const memberships = new Map<string, string[]>();
  for (const rootPath of EXPECTED_STUDY_ROOTS) {
    const root = rootByPath.get(rootPath);
    if (!root) continue;

    const urls = new Set<string>();
    collectFolderPageUrls(root, urls);
    for (const url of urls) {
      const owners = memberships.get(url) ?? [];
      owners.push(rootPath);
      memberships.set(url, owners);
    }
  }

  const pages = source.getPages();
  const orphaned = pages
    .filter((page) => !memberships.has(page.url))
    .map((page) => `${page.url} (${page.path})`);
  const duplicated = pages
    .filter((page) => (memberships.get(page.url)?.length ?? 0) !== 1)
    .map((page) => `${page.url} => ${(memberships.get(page.url) ?? []).join(', ') || '(none)'}`);
  const misplacedMathQuestionTypes = pages
    .filter((page) => page.url === '/docs/math-question-types' || page.url.startsWith('/docs/math-question-types/'))
    .filter((page) => memberships.get(page.url)?.[0] !== 'math')
    .map((page) => page.url);

  if (orphaned.length > 0 || duplicated.length > 0 || misplacedMathQuestionTypes.length > 0) {
    throw new Error(
      [
        '[study-modules] Every documentation page must belong to exactly one study Root Folder.',
        orphaned.length > 0 ? `Orphaned pages: ${orphaned.join('; ')}` : '',
        duplicated.length > 0 ? `Invalid memberships: ${duplicated.join('; ')}` : '',
        misplacedMathQuestionTypes.length > 0
          ? `Math question-type pages outside math root: ${misplacedMathQuestionTypes.join('; ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}

assertStudyModuleTree();

export const blogSource = loader({
  baseUrl: '/blog',
  source: toFumadocsSource(blog, []),
});
