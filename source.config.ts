import { remarkMdxMermaid, remarkStructure } from 'fumadocs-core/mdx-plugins';
import { pageSchema } from 'fumadocs-core/source/schema';
import { defineCollections, defineConfig, defineDocs } from 'fumadocs-mdx/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { z } from 'zod';

const isStaticDocsBuild = process.env.STATIC_DOCS_BUILD === '1';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    // The pure-static CDN build generates direct .md files itself, so avoid
    // generating duplicate processed Markdown during that build.
    postprocess: isStaticDocsBuild
      ? undefined
      : {
          includeProcessedMarkdown: true,
        },
    schema: pageSchema.extend({
      taskRecordId: z.string().regex(/^[a-z0-9]{15}$/u).optional(),
      messageRecordId: z.string().regex(/^[a-z0-9]{15}$/u).optional(),
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
    // The pure-static CDN build does not consume Fumadocs' generated structure
    // index, so skip that traversal there.
    remarkPlugins: (plugins) => [
      ...(isStaticDocsBuild
        ? plugins.filter((plugin) => {
            const entry = Array.isArray(plugin) ? plugin[0] : plugin;
            return entry !== remarkStructure;
          })
        : plugins),
      remarkMath,
      remarkMdxMermaid,
    ],
    // Do not make production builds depend on third-party image hosts.
    remarkImageOptions: { external: false },
    // Silence KaTeX strict-mode compatibility warnings (for example CJK text
    // accidentally placed inside $...$), while keeping real parse errors fatal.
    // KaTeX's default throwOnError remains enabled.
    rehypePlugins: (plugins) => [
      [rehypeKatex, { strict: 'ignore' }],
      ...plugins,
    ],
  },
});
