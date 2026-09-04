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
    // Production exposes /llms.mdx routes through getText('processed'), while
    // the isolated pure-static CDN build generates its own direct .md files.
    // Keep processed Markdown in production, but avoid that duplicate work in
    // the static-only build where it is not consumed.
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
    // The pure-static CDN build does not use Fumadocs' generated structure
    // index, so skip that extra traversal there. Production keeps the normal
    // plugin set because /llms.mdx and the full application still consume the
    // processed document representation.
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
    // KaTeX must run before Fumadocs' syntax highlighter.
    rehypePlugins: (plugins) => [rehypeKatex, ...plugins],
  },
});
