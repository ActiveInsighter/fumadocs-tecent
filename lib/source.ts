import { blog, docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server';

const conciseMathModuleTitle = /^(?:高等数学|线性代数|概率论与数理统计)\s*模块\s*(\d+)\s*[：:]\s*(.+)$/u;

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

export const blogSource = loader({
  baseUrl: '/blog',
  source: toFumadocsSource(blog, []),
});
