import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
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

export const articles = defineDocs({
  dir: 'content/articles',
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid],
    // KaTeX must run before Fumadocs' syntax highlighter.
    rehypePlugins: (plugins) => [rehypeKatex, ...plugins],
  },
});
