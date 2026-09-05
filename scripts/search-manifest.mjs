import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

export const SEARCH_PUBLIC_MANIFEST_VERSION = 4;
export const SEARCH_PUBLIC_MANIFEST_MODE = 'category-bloom-router-shards';
export const SEARCH_ROUTER_VERSION = 2;
export const SEARCH_FILE_MAX_BYTES = 25_000_000;

function compressionSizes(json) {
  return {
    bytes: Buffer.byteLength(json),
    gzipBytes: gzipSync(json, { level: 6 }).byteLength,
    brotliBytes: brotliCompressSync(json, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
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
 * Both lightweight page records and full-text records are routed by category.
 * The stable root manifest therefore contains only one bounded Bloom summary
 * per top-level category plus content-addressed router URLs; it never embeds
 * every page/shard database descriptor.
 */
export async function finalizeSearchManifest({ manifestFile } = {}) {
  if (!manifestFile) throw new Error('finalizeSearchManifest requires manifestFile.');

  const raw = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (
    raw.version !== 2 ||
    raw.engine !== 'zbsearch' ||
    raw.mode !== 'routed-core-body-shards' ||
    !Array.isArray(raw.categories) ||
    !Array.isArray(raw.core?.shards) ||
    !Array.isArray(raw.body?.shards)
  ) {
    throw new Error('Expected the routed core/body ZBSearch manifest before finalization.');
  }

  const searchDirectory = path.join(path.dirname(manifestFile), 'search');
  const rawCategoryMap = new Map(raw.categories.map((category) => [category.id, category]));
  const coreByCategory = new Map();
  const bodyByCategory = new Map();

  for (const shard of raw.core.shards) {
    const list = coreByCategory.get(shard.category) ?? [];
    list.push(shard);
    coreByCategory.set(shard.category, list);
  }
  for (const shard of raw.body.shards) {
    const list = bodyByCategory.get(shard.category) ?? [];
    list.push(shard);
    bodyByCategory.set(shard.category, list);
  }

  const categoryEntries = [];
  const routerFiles = [];

  for (const categoryMeta of [...raw.categories].sort((left, right) => left.id.localeCompare(right.id))) {
    const category = categoryMeta.id;
    const core = coreByCategory.get(category) ?? [];
    const body = bodyByCategory.get(category) ?? [];

    const sortShards = (left, right) => {
      if (left.group !== right.group) return left.group.localeCompare(right.group);
      return left.url.localeCompare(right.url);
    };
    core.sort(sortShards);
    body.sort(sortShards);

    const router = {
      version: SEARCH_ROUTER_VERSION,
      engine: 'zbsearch',
      category,
      core,
      body,
    };
    const json = JSON.stringify(router);
    const sizes = compressionSizes(json);
    if (sizes.bytes >= SEARCH_FILE_MAX_BYTES) {
      throw new Error(`Search router for ${category} is ${sizes.bytes} bytes, above the EdgeOne single-file limit.`);
    }

    const fileName = `router-${safeFileSegment(category)}-${digest(json)}.json`;
    await writeFile(path.join(searchDirectory, fileName), json);

    const routerFile = { url: `/search/${fileName}`, ...sizes };
    routerFiles.push(routerFile);
    categoryEntries.push({
      id: category,
      groups: rawCategoryMap.get(category)?.groups ?? [],
      route: categoryMeta.route,
      coreShards: core.length,
      bodyShards: body.length,
      records: body.reduce((sum, shard) => sum + shard.records, 0),
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
    storage: {
      core: {
        bytes: raw.core.bytes,
        gzipBytes: raw.core.gzipBytes,
        brotliBytes: raw.core.brotliBytes,
      },
      body: {
        bytes: raw.body.bytes,
        gzipBytes: raw.body.gzipBytes,
        brotliBytes: raw.body.brotliBytes,
      },
      routers: routerTotals,
    },
    categories: categoryEntries,
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
