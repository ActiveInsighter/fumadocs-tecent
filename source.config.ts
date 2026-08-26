import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { pageSchema } from 'fumadocs-core/source/schema';
import { defineCollections, defineConfig, defineDocs } from 'fumadocs-mdx/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
    schema: pageSchema.extend({
      documentId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
        .optional(),
      documentVersion: z.coerce.number().int().positive().max(999_999_999).optional(),
    }),
  },
});

export const blog = defineCollections({
  type: 'doc',
  dir: 'content/blog',
  schema: pageSchema.extend({
    date: z.coerce.date(),
    author: z.string().optional(),
  }),
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid],
    // KaTeX must run before Fumadocs' syntax highlighter.
    rehypePlugins: (plugins) => [rehypeKatex, ...plugins],
  },
});
