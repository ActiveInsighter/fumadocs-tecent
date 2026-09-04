import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { frontmatter } from 'fumadocs-core/content/md/frontmatter';
import { remarkMdxMermaid, structure } from 'fumadocs-core/mdx-plugins';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import {
  getStaticDocsPageUrl,
  isStaticDocSourceFile,
} from './static-docs-markdown.mjs';

function normalizeSourcePath(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function getPathTitle(relativePath) {
  const normalizedPath = normalizeSourcePath(relativePath);
  const withoutExtension = normalizedPath.replace(/\.(md|mdx)$/i, '');
  return withoutExtension.split('/').pop() || 'Untitled';
}

function getMetadata(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function buildStructuredData(content) {
  let structured;

  try {
    structured = structure(content, [remarkMdx, remarkMath, remarkMdxMermaid]);
  } catch {
    // A few legacy notes contain raw comparisons such as `A<B` outside code
    // fences. They are valid Markdown but not valid MDX JSX, so retry with the
    // Markdown parser and keep those notes searchable instead of dropping them.
    structured = structure(content, [remarkMath, remarkMdxMermaid]);
  }

  // The Markdown fallback escapes a literal `<` while stringifying table
  // cells. Search should receive the text a reader sees in the document.
  return {
    headings: structured.headings.map((heading) => ({
      ...heading,
      content: heading.content.replaceAll('\\<', '<'),
    })),
    contents: structured.contents.map((entry) => ({
      ...entry,
      content: entry.content.replaceAll('\\<', '<'),
    })),
  };
}

/**
 * Convert one source document to the record shape expected by Fumadocs'
 * Algolia sync helper. One Algolia record is created for each searchable
 * heading/content block, so results can point to the relevant section.
 */
export function buildAlgoliaDocument(relativePath, content) {
  const parsed = frontmatter(content);
  const metadata = getMetadata(parsed.data);
  const title =
    typeof metadata.title === 'string' && metadata.title.trim()
      ? metadata.title.trim()
      : getPathTitle(relativePath);
  const description =
    typeof metadata.description === 'string' && metadata.description.trim()
      ? metadata.description.trim()
      : undefined;
  const url = getStaticDocsPageUrl(relativePath);

  return {
    _id: url,
    title,
    ...(description ? { description } : {}),
    url,
    structured: buildStructuredData(parsed.content),
  };
}

async function walkFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(filePath)));
    } else if (entry.isFile() && isStaticDocSourceFile(filePath)) {
      files.push(filePath);
    }
  }

  return files;
}

export async function collectAlgoliaDocuments(contentRoot = path.resolve('content/docs')) {
  const sourceFiles = await walkFiles(contentRoot);
  sourceFiles.sort((left, right) => left.localeCompare(right));

  return Promise.all(
    sourceFiles.map(async (sourcePath) => {
      const relativePath = path.relative(contentRoot, sourcePath);
      return buildAlgoliaDocument(relativePath, await readFile(sourcePath, 'utf8'));
    }),
  );
}
