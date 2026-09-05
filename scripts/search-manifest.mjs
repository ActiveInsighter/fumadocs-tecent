import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

export const SEARCH_PUBLIC_MANIFEST_VERSION = 3;
export const SEARCH_PUBLIC_MANIFEST_MODE = 'tiered-category-router-shards';
export const SEARCH_ROUTER_VERSION = 1;
export const SEARCH_FILE_MAX_BYTES = 25_000_000;

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

function safeFileSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function digest(json) {
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

function sumSizes(items) {
  return items.reduce(
    (result, item) => ({
      bytes: result.bytes + item.bytes,
      gzipBytes: result.gzipBytes + item.gzipBytes,
      brotliBytes: result.brotliBytes + item.brotliBytes,
    }),
    { bytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}

/**
 * The raw ZBSearch builder emits per-shard Bloom filters. Keeping every Bloom
 * filter in /search-index.json would make the first-search manifest grow
 * linearly with a future hundreds-of-shards corpus. This post-processing step
 * moves shard metadata into content-addressed category routers, leaving the
 * root manifest tiny and stable even when the documentation grows by orders of
 * magnitude.
 */
export async function finalizeSearchManifest({ manifestFile } = {}) {
  if (!manifestFile) throw new Error('finalizeSearchManifest requires manifestFile.');

  const raw = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (
    raw.version !== 2 ||
    raw.engine !== 'zbsearch' ||
    raw.mode !== 'tiered-bloom-shards' ||
    !Array.isArray(raw.body?.shards)
  ) {
    throw new Error('Expected the internal tiered ZBSearch manifest before finalization.');
  }

  const searchDirectory = path.join(path.dirname(manifestFile), 'search');
  const categories = new Map();
  for (const shard of raw.body.shards) {
    const list = categories.get(shard.category) ?? [];
    list.push(shard);
    categories.set(shard.category, list);
  }

  const categoryEntries = [];
  const routerFiles = [];

  for (const [category, shards] of Array.from(categories.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    shards.sort((left, right) => {
      if (left.group !== right.group) return left.group.localeCompare(right.group);
      return left.url.localeCompare(right.url);
    });

    const router = {
      version: SEARCH_ROUTER_VERSION,
      engine: 'zbsearch',
      category,
      shards,
    };
    const json = JSON.stringify(router);
    const sizes = compressionSizes(json);
    if (sizes.bytes >= SEARCH_FILE_MAX_BYTES) {
      throw new Error(`Search router for ${category} is ${sizes.bytes} bytes, above the EdgeOne single-file limit.`);
    }

    const fileName = `router-${safeFileSegment(category)}-${digest(json)}.json`;
    const filePath = path.join(searchDirectory, fileName);
    await writeFile(filePath, json);

    const routerFile = {
      url: `/search/${fileName}`,
      ...sizes,
    };
    routerFiles.push(routerFile);
    categoryEntries.push({
      id: category,
      groups: Array.from(new Set(shards.map((shard) => shard.group))).sort(),
      shards: shards.length,
      records: shards.reduce((sum, shard) => sum + shard.records, 0),
      router: routerFile,
    });
  }

  const routerTotals = sumSizes(routerFiles);
  const publicManifest = {
    version: SEARCH_PUBLIC_MANIFEST_VERSION,
    engine: 'zbsearch',
    mode: SEARCH_PUBLIC_MANIFEST_MODE,
    pages: raw.pages,
    records: raw.records,
    routing: raw.routing,
    core: raw.core,
    body: {
      bytes: raw.body.bytes,
      gzipBytes: raw.body.gzipBytes,
      brotliBytes: raw.body.brotliBytes,
      routers: routerTotals,
      categories: categoryEntries,
    },
  };

  const publicJson = JSON.stringify(publicManifest);
  const manifestSizes = compressionSizes(publicJson);
  if (manifestSizes.bytes >= SEARCH_FILE_MAX_BYTES) {
    throw new Error(`Public search manifest is ${manifestSizes.bytes} bytes, above the EdgeOne single-file limit.`);
  }
  await writeFile(manifestFile, publicJson);

  return {
    categories: categoryEntries.length,
    routers: routerFiles.length,
    routerFiles,
    routerTotals,
    manifest: manifestSizes,
  };
}
