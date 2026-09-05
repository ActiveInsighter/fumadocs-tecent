import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { frontmatter } from 'fumadocs-core/content/md/frontmatter';
import { remarkMdxMermaid, structure } from 'fumadocs-core/mdx-plugins';
import { initSimpleSearch } from 'fumadocs-core/search/server';
import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import {
  getStaticDocsPageUrl,
  isStaticDocSourceFile,
} from './static-docs-markdown.mjs';

export const ZBSEARCH_WARNING_BYTES = 15_000_000;
export const ZBSEARCH_MAX_BYTES = 25_000_000;
export const ZBSEARCH_SHARD_COUNT = 3;

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

/**
 * ZBSearch's advanced Fumadocs index creates one search document for every
 * paragraph/table cell. On this content set that expands beyond 100 MiB. For
 * the static CDN build we keep one simple ZBSearch document per heading:
 * contents under the same heading are concatenated into one searchable record.
 * This preserves heading anchors while substantially reducing index overhead.
 */
export function buildZBSearchSectionIndexes(page) {
  const sections = new Map();
  const rootContent = [];

  for (const entry of page.structuredData.contents) {
    if (entry.heading) {
      const list = sections.get(entry.heading) ?? [];
      list.push(entry.content);
      sections.set(entry.heading, list);
    } else {
      rootContent.push(entry.content);
    }
  }

  const result = [
    {
      title: page.title,
      description: page.description,
      breadcrumbs: [],
      content: [page.description, ...rootContent].filter(Boolean).join('\n\n'),
      keywords: page.title,
      url: page.url,
    },
  ];

  for (const heading of page.structuredData.headings) {
    result.push({
      title: heading.content,
      breadcrumbs: [page.title],
      content: (sections.get(heading.id) ?? []).join('\n\n'),
      keywords: page.title,
      url: `${page.url}#${heading.id}`,
    });
  }

  return result;
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

function stableShardIndex(value, count) {
  // FNV-1a gives deterministic distribution without moving every document
  // whenever a new page is added.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
}

function compressionSizes(json) {
  return {
    bytes: Buffer.byteLength(json),
    gzipBytes: gzipSync(json, { level: 6 }).byteLength,
    brotliBytes: brotliCompressSync(json, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
      },
    }).byteLength,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export async function buildZBSearchIndex({
  contentRoot = path.resolve('content/docs'),
  outputFile,
} = {}) {
  if (!outputFile) {
    throw new Error('buildZBSearchIndex requires an outputFile.');
  }

  const pages = await collectZBSearchSourceIndexes(contentRoot);
  const shardIndexes = Array.from({ length: ZBSEARCH_SHARD_COUNT }, () => []);
  let recordCount = 0;

  for (const page of pages) {
    const records = buildZBSearchSectionIndexes(page);
    recordCount += records.length;
    shardIndexes[stableShardIndex(page.url, ZBSEARCH_SHARD_COUNT)].push(...records);
  }

  const outputDirectory = path.dirname(outputFile);
  const outputBaseName = path.basename(outputFile, path.extname(outputFile));
  await mkdir(outputDirectory, { recursive: true });

  const shardResults = [];
  for (let index = 0; index < shardIndexes.length; index += 1) {
    const records = shardIndexes[index];
    const server = initSimpleSearch({ indexes: records });
    const json = JSON.stringify(await server.export());
    const sizes = compressionSizes(json);
    const fileName = `${outputBaseName}-${index}.json`;
    const filePath = path.join(outputDirectory, fileName);

    console.log(
      `[zbsearch] Shard ${index + 1}/${ZBSEARCH_SHARD_COUNT}: ${records.length} records; raw ${formatMiB(sizes.bytes)}; gzip ${formatMiB(sizes.gzipBytes)}; brotli ${formatMiB(sizes.brotliBytes)}.`,
    );

    if (sizes.bytes >= ZBSEARCH_MAX_BYTES) {
      throw new Error(
        `ZBSearch shard ${fileName} is ${sizes.bytes} bytes, at or above the EdgeOne 25 MB single-file limit.`,
      );
    }

    if (sizes.bytes >= ZBSEARCH_WARNING_BYTES) {
      console.warn(
        `[zbsearch] Warning: ${fileName} is ${formatMiB(sizes.bytes)} raw; consider increasing the shard count.`,
      );
    }

    await writeFile(filePath, json);
    shardResults.push({
      fileName,
      filePath,
      records: records.length,
      ...sizes,
    });
  }

  const manifest = {
    version: 1,
    engine: 'zbsearch',
    mode: 'simple-section-shards',
    pages: pages.length,
    records: recordCount,
    shards: shardResults.map((shard) => `/${shard.fileName}`),
  };
  await writeFile(outputFile, JSON.stringify(manifest));

  const totals = shardResults.reduce(
    (result, shard) => ({
      bytes: result.bytes + shard.bytes,
      gzipBytes: result.gzipBytes + shard.gzipBytes,
      brotliBytes: result.brotliBytes + shard.brotliBytes,
    }),
    { bytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );

  console.log(
    `[zbsearch] Total: ${pages.length} pages -> ${recordCount} section records; raw ${formatMiB(totals.bytes)}; gzip ${formatMiB(totals.gzipBytes)}; brotli ${formatMiB(totals.brotliBytes)}.`,
  );

  return {
    pages: pages.length,
    records: recordCount,
    shards: shardResults,
    ...totals,
    outputFile,
  };
}

async function main() {
  const outputFile = path.resolve(process.argv[2] ?? 'public/search-index.json');
  const result = await buildZBSearchIndex({ outputFile });

  console.log(`[zbsearch] Indexed ${result.pages} pages into ${result.records} section records.`);
  console.log(`[zbsearch] Raw total: ${formatMiB(result.bytes)}.`);
  console.log(`[zbsearch] Gzip total estimate: ${formatMiB(result.gzipBytes)}.`);
  console.log(`[zbsearch] Brotli total estimate: ${formatMiB(result.brotliBytes)}.`);
  console.log(`[zbsearch] Wrote ${path.relative(process.cwd(), result.outputFile)} plus ${result.shards.length} shards.`);
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
