import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { frontmatter } from 'fumadocs-core/content/md/frontmatter';
import { remarkMdxMermaid, structure } from 'fumadocs-core/mdx-plugins';
import { initAdvancedSearch } from 'fumadocs-core/search/server';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import {
  getStaticDocsPageUrl,
  isStaticDocSourceFile,
} from './static-docs-markdown.mjs';

export const ZBSEARCH_WARNING_BYTES = 15_000_000;
export const ZBSEARCH_MAX_BYTES = 25_000_000;

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

export function buildStructuredSearchData(content) {
  let structured;

  try {
    structured = structure(content, [remarkMdx, remarkMath, remarkMdxMermaid]);
  } catch {
    // Some legacy notes contain raw comparisons such as `A<B` outside code
    // fences. They are valid Markdown but not valid MDX JSX, so retry with a
    // Markdown parser instead of dropping those documents from search.
    structured = structure(content, [remarkMath, remarkMdxMermaid]);
  }

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

export function buildZBSearchSourceIndex(relativePath, content) {
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
    id: url,
    title,
    ...(description ? { description } : {}),
    url,
    structuredData: buildStructuredSearchData(parsed.content),
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

export async function collectZBSearchSourceIndexes(
  contentRoot = path.resolve('content/docs'),
) {
  const sourceFiles = await walkFiles(contentRoot);
  sourceFiles.sort((left, right) => left.localeCompare(right));

  return Promise.all(
    sourceFiles.map(async (sourcePath) => {
      const relativePath = path.relative(contentRoot, sourcePath);
      return buildZBSearchSourceIndex(relativePath, await readFile(sourcePath, 'utf8'));
    }),
  );
}

export async function buildZBSearchIndex({
  contentRoot = path.resolve('content/docs'),
  outputFile,
} = {}) {
  if (!outputFile) {
    throw new Error('buildZBSearchIndex requires an outputFile.');
  }

  const indexes = await collectZBSearchSourceIndexes(contentRoot);
  const server = initAdvancedSearch({ indexes });
  const exported = await server.export();
  const json = JSON.stringify(exported);
  const bytes = Buffer.byteLength(json);

  // These are observability estimates only. Moderate compression levels keep
  // the measurement cheap enough to run on every build while remaining close
  // to CDN transfer sizes.
  const gzipBytes = gzipSync(json, { level: 6 }).byteLength;
  const brotliBytes = brotliCompressSync(json, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  }).byteLength;

  if (bytes >= ZBSEARCH_MAX_BYTES) {
    throw new Error(
      `ZBSearch index is ${bytes} bytes, at or above the EdgeOne 25 MB single-file limit.`,
    );
  }

  if (bytes >= ZBSEARCH_WARNING_BYTES) {
    console.warn(
      `[zbsearch] Warning: raw search index is ${(bytes / 1024 / 1024).toFixed(2)} MiB; ` +
        'consider moving to a hosted search service before first-search load time becomes excessive.',
    );
  }

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, json);

  return {
    pages: indexes.length,
    bytes,
    gzipBytes,
    brotliBytes,
    outputFile,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const outputFile = path.resolve(process.argv[2] ?? 'public/search-index.json');
  const result = await buildZBSearchIndex({ outputFile });

  console.log(`[zbsearch] Indexed ${result.pages} pages.`);
  console.log(`[zbsearch] Raw index: ${formatMiB(result.bytes)}.`);
  console.log(`[zbsearch] Gzip estimate: ${formatMiB(result.gzipBytes)}.`);
  console.log(`[zbsearch] Brotli estimate: ${formatMiB(result.brotliBytes)}.`);
  console.log(`[zbsearch] Wrote ${path.relative(process.cwd(), result.outputFile)}.`);
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error('[zbsearch] Failed to build search index.', error);
    process.exitCode = 1;
  });
}
