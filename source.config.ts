import {
  rehypeCodeDefaultOptions,
  remarkMdxMermaid,
} from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { transformerTwoslash } from 'fumadocs-twoslash';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid],
    // KaTeX must run before Fumadocs' syntax highlighter.
    rehypePlugins: (plugins) => [rehypeKatex, ...plugins],
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash(),
      ],
      // Twoslash popovers cannot lazy-load syntax grammars.
      langs: ['js', 'jsx', 'ts', 'tsx'],
    },
  },
});
