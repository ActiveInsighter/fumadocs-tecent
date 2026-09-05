import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

export const SEARCH_MANIFEST_VERSION = 2;
export const SEARCH_MANIFEST_MODE = 'routed-core-body-shards';
export const ZBSEARCH_WARNING_BYTES = 15_000_000;
export const ZBSEARCH_SOFT_MAX_BYTES = 10_000_000;
export const ZBSEARCH_MAX_BYTES = 25_000_000;
export const ZBSEARCH_SOURCE_TARGET_CHARS = 650_000;
export const ZBSEARCH_CORE_SOURCE_TARGET_CHARS = 300_000;
export const ZBSEARCH_MAX_SECTION_CHARS = 6_000;
export const ZBSEARCH_CORE_HEADING_CHARS = 600;

const BLOOM_HASHES = 4;
const BLOOM_BITS_PER_TOKEN = 10;
const BLOOM_MIN_BITS = 16_384;
const BLOOM_MAX_BITS = 65_536;
const CATEGORY_BLOOM_MIN_BITS = 32_768;
const CATEGORY_BLOOM_MAX_BITS = 2_097_152;

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

function trimToCodePoints(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * Search bytes should represent concepts, not serialized formulas/markup.
 * Fumadocs already omits fenced code blocks from structuredData by default;
 * this additionally removes low-value math/URL/MDX payload from paragraphs.
 */
export function sanitizeSearchText(value) {
  if (!value) return '';

  let text = String(value).normalize('NFKC');
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/\\text\{([^{}]{0,300})\}/g, ' $1 ')
    .replace(/\\operatorname\{([^{}]{0,120})\}/g, ' $1 ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\$[^$\n]{1,2000}\$/g, ' ')
    .replace(/\\(?:begin|end)\{[^{}]{1,80}\}/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]{0,100}\])?/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[{}_^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const naturalChars = text.match(/[\p{L}\p{N}\p{Script=Han}]/gu)?.length ?? 0;
  return naturalChars >= 2 ? text : '';
}

function normalizeRoutingText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

/**
 * CJK bigrams work without a dictionary. Latin words also contribute trigrams
 * so routing still finds likely shards for small spelling mistakes.
 */
export function buildSearchRoutingTokens(value) {
  const normalized = normalizeRoutingText(value);
  const tokens = new Set();
  const words = normalized.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];

  for (const word of words) {
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = Array.from(word);
      if (chars.length === 1) tokens.add(`c:${chars[0]}`);
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.add(`c2:${chars[index]}${chars[index + 1]}`);
      }
      if (chars.length >= 2 && chars.length <= 8) tokens.add(`cw:${word}`);
      continue;
    }

    if (word.length >= 2) tokens.add(`w:${word}`);
    if (word.length >= 4) {
      for (let index = 0; index + 2 < word.length; index += 1) {
        tokens.add(`g:${word.slice(index, index + 3)}`);
      }
    }
  }

  return Array.from(tokens);
}

export function getSearchScope(relativePath) {
  const normalized = normalizeSourcePath(relativePath).replace(/\.(md|mdx)$/i, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === 'index') segments.pop();

  if (segments.length === 0) return { category: 'root', group: 'root' };

  const category = segments[0];
  const group = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : category;
  return { category, group };
}

export function buildStructuredSearchData(content) {
  let structured;

  try {
    structured = structure(content, [remarkMdx, remarkMath, remarkMdxMermaid]);
  } catch {
    // Legacy notes can contain raw comparisons such as A<B which Markdown
    // accepts but the MDX JSX parser rejects.
    structured = structure(content, [remarkMath, remarkMdxMermaid]);
  }

  return {
    headings: structured.headings
      .map((heading) => ({
        ...heading,
        content: sanitizeSearchText(heading.content.replaceAll('\\<', '<')),
      }))
      .filter((heading) => heading.content.length > 0),
    contents: structured.contents
      .map((entry) => ({
        ...entry,
        content: sanitizeSearchText(entry.content.replaceAll('\\<', '<')),
      }))
      .filter((entry) => entry.content.length > 0),
  };
}

export function buildZBSearchSourceIndex(relativePath, content) {
  const parsed = frontmatter(content);
  const metadata = getMetadata(parsed.data);
  const title =
    sanitizeSearchText(
      typeof metadata.title === 'string' && metadata.title.trim()
        ? metadata.title.trim()
        : getPathTitle(relativePath),
    ) || getPathTitle(relativePath);
  const description =
    typeof metadata.description === 'string' && metadata.description.trim()
      ? trimToCodePoints(sanitizeSearchText(metadata.description), 300)
      : undefined;
  const url = getStaticDocsPageUrl(relativePath);
  const scope = getSearchScope(relativePath);

  return {
    id: url,
    relativePath: normalizeSourcePath(relativePath),
    title,
    ...(description ? { description } : {}),
    url,
    ...scope,
    structuredData: buildStructuredSearchData(parsed.content),
  };
}

function chunkParagraphs(paragraphs, maxChars = ZBSEARCH_MAX_SECTION_CHARS) {
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  for (const paragraph of paragraphs) {
    const clean = sanitizeSearchText(paragraph);
    if (!clean) continue;

    const chars = Array.from(clean);
    const pieces = [];
    for (let start = 0; start < chars.length; start += maxChars) {
      pieces.push(chars.slice(start, start + maxChars).join(''));
    }

    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }

      if (Array.from(current).length + Array.from(piece).length + 2 <= maxChars) {
        current += `\n\n${piece}`;
      } else {
        pushCurrent();
        current = piece;
      }
    }
  }

  pushCurrent();
  return chunks;
}

function makeSectionRecords({ title, breadcrumbs, url, paragraphs, keywords, description }) {
  const chunks = chunkParagraphs(paragraphs);
  if (chunks.length === 0) chunks.push('');

  return chunks.map((content, index) => ({
    title,
    description: index === 0 ? description : undefined,
    breadcrumbs,
    content,
    keywords,
    url,
  }));
}

/**
 * Full text is stored per heading, but pathological long headings are split
 * into bounded chunks behind the same anchor. The UI de-duplicates the URL.
 */
export function buildZBSearchSectionIndexes(page) {
  const sectionTitles = new Map(
    page.structuredData.headings.map((heading) => [heading.id, heading.content]),
  );
  const sections = new Map();
  const seenBySection = new Map();
  const rootContent = [];
  const rootSeen = new Set();

  for (const entry of page.structuredData.contents) {
    const content = sanitizeSearchText(entry.content);
    if (!content) continue;

    if (!entry.heading) {
      if (!rootSeen.has(content)) {
        rootSeen.add(content);
        rootContent.push(content);
      }
      continue;
    }

    const seen = seenBySection.get(entry.heading) ?? new Set();
    if (seen.has(content)) continue;
    seen.add(content);
    seenBySection.set(entry.heading, seen);

    const list = sections.get(entry.heading) ?? [];
    list.push(content);
    sections.set(entry.heading, list);
  }

  const result = makeSectionRecords({
    title: page.title,
    description: page.description,
    breadcrumbs: page.category === 'root' ? [] : [page.category],
    paragraphs: rootContent,
    keywords: `${page.title} ${page.category}`,
    url: page.url,
  });

  const headingIds = new Set([
    ...page.structuredData.headings.map((heading) => heading.id),
    ...sections.keys(),
  ]);

  for (const headingId of headingIds) {
    const headingTitle = sectionTitles.get(headingId) || page.title;
    result.push(
      ...makeSectionRecords({
        title: headingTitle,
        breadcrumbs: [page.title],
        paragraphs: sections.get(headingId) ?? [],
        keywords: `${page.title} ${headingTitle} ${page.category}`,
        url: `${page.url}#${headingId}`,
      }),
    );
  }

  return result;
}

export function buildZBSearchCoreIndex(page) {
  const headingSummary = trimToCodePoints(
    page.structuredData.headings.map((heading) => heading.content).join(' · '),
    ZBSEARCH_CORE_HEADING_CHARS,
  );

  return {
    title: page.title,
    description: page.description,
    breadcrumbs: page.category === 'root' ? [] : [page.category],
    content: headingSummary,
    keywords: `${page.title} ${page.category} ${page.group}`,
    url: page.url,
  };
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(filePath)));
    else if (entry.isFile() && isStaticDocSourceFile(filePath)) files.push(filePath);
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

function hash32(value, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hash32Secondary(value) {
  let hash = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x85ebca6b);
    hash ^= hash >>> 13;
  }
  return (hash | 1) >>> 0;
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function recordText(record) {
  return [
    record.title,
    record.description,
    record.content,
    record.keywords,
    ...(record.breadcrumbs ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

function buildBloomRoute(
  records,
  { minBits = BLOOM_MIN_BITS, maxBits = BLOOM_MAX_BITS } = {},
) {
  const tokens = new Set();
  for (const record of records) {
    for (const token of buildSearchRoutingTokens(recordText(record))) tokens.add(token);
  }

  const bitCount = nextPowerOfTwo(
    clamp(tokens.size * BLOOM_BITS_PER_TOKEN, minBits, maxBits),
  );
  const bytes = Buffer.alloc(bitCount / 8);

  for (const token of tokens) {
    const first = hash32(token);
    const second = hash32Secondary(token);
    for (let index = 0; index < BLOOM_HASHES; index += 1) {
      const bit = (first + Math.imul(index, second)) & (bitCount - 1);
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }

  return {
    bits: bitCount,
    hashes: BLOOM_HASHES,
    tokens: tokens.size,
    data: bytes.toString('base64'),
  };
}

function compressionSizes(json) {
  return {
    bytes: Buffer.byteLength(json),
    gzipBytes: gzipSync(json, { level: 6 }).byteLength,
    brotliBytes: brotliCompressSync(json, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    }).byteLength,
  };
}

function recordSourceChars(record) {
  return Array.from(recordText(record)).length;
}

function safeFileSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function contentDigest(json) {
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function exportSimpleIndex(records) {
  const server = initSimpleSearch({ indexes: records });
  return JSON.stringify(await server.export());
}

function splitStableUnits(units, targetChars, depth = 0, prefix = '') {
  const totalChars = units.reduce((sum, unit) => sum + unit.chars, 0);
  if (totalChars <= targetChars || units.length <= 1) {
    return [{ key: prefix || '0', units }];
  }

  if (depth >= 12) {
    const sorted = [...units].sort((left, right) => left.key.localeCompare(right.key));
    const midpoint = Math.ceil(sorted.length / 2);
    return [
      ...splitStableUnits(sorted.slice(0, midpoint), targetChars, depth + 1, `${prefix}a`),
      ...splitStableUnits(sorted.slice(midpoint), targetChars, depth + 1, `${prefix}b`),
    ];
  }

  const buckets = Array.from({ length: 4 }, () => []);
  for (const unit of units) {
    buckets[hash32(`${depth}:${unit.key}`) & 3].push(unit);
  }

  const nonEmpty = buckets.filter((bucket) => bucket.length > 0);
  if (nonEmpty.length === 1) {
    return splitStableUnits(units, targetChars, depth + 1, `${prefix}x`);
  }

  return buckets.flatMap((bucket, index) =>
    bucket.length === 0
      ? []
      : splitStableUnits(bucket, targetChars, depth + 1, `${prefix}${index}`),
  );
}

function splitLargePageUnit(unit) {
  if (unit.chars <= ZBSEARCH_SOURCE_TARGET_CHARS) return [unit];

  const result = [];
  let records = [];
  let chars = 0;
  let part = 0;

  for (const record of unit.records) {
    const recordChars = recordSourceChars(record);
    if (records.length > 0 && chars + recordChars > ZBSEARCH_SOURCE_TARGET_CHARS) {
      result.push({ ...unit, key: `${unit.key}|${part}`, records, chars });
      records = [];
      chars = 0;
      part += 1;
    }
    records.push(record);
    chars += recordChars;
  }

  if (records.length > 0) result.push({ ...unit, key: `${unit.key}|${part}`, records, chars });
  return result;
}

function splitRecordsForSafety(records, depth) {
  const buckets = [[], []];
  for (const record of records) {
    const key = `${record.url}\u0000${record.title}\u0000${String(record.content).slice(0, 96)}`;
    buckets[(hash32(`${depth}:${key}`) >>> depth) & 1].push(record);
  }

  if (buckets[0].length === 0 || buckets[1].length === 0) {
    const midpoint = Math.ceil(records.length / 2);
    return [records.slice(0, midpoint), records.slice(midpoint)];
  }
  return buckets;
}

async function writeRoutedShard({
  kind,
  records,
  category,
  group,
  key,
  searchDirectory,
  depth = 0,
}) {
  const json = await exportSimpleIndex(records);
  const sizes = compressionSizes(json);

  if (sizes.bytes > ZBSEARCH_SOFT_MAX_BYTES && records.length > 1) {
    const [left, right] = splitRecordsForSafety(records, depth);
    return [
      ...(await writeRoutedShard({
        kind,
        records: left,
        category,
        group,
        key: `${key}a`,
        searchDirectory,
        depth: depth + 1,
      })),
      ...(await writeRoutedShard({
        kind,
        records: right,
        category,
        group,
        key: `${key}b`,
        searchDirectory,
        depth: depth + 1,
      })),
    ];
  }

  if (sizes.bytes >= ZBSEARCH_MAX_BYTES) {
    throw new Error(`${kind} ZBSearch shard ${group}/${key} is ${sizes.bytes} bytes, above the EdgeOne limit.`);
  }

  if (sizes.bytes >= ZBSEARCH_WARNING_BYTES) {
    console.warn(`[zbsearch] Warning: ${kind} shard ${group}/${key} is ${formatMiB(sizes.bytes)} raw.`);
  }

  const digest = contentDigest(json);
  const fileName = `${kind}-${safeFileSegment(group)}-${safeFileSegment(key)}-${digest}.json`;
  await writeFile(path.join(searchDirectory, fileName), json);

  return [{
    url: `/search/${fileName}`,
    category,
    group,
    records: records.length,
    route: buildBloomRoute(records),
    ...sizes,
  }];
}

function sumSizes(shards) {
  return shards.reduce(
    (result, shard) => ({
      bytes: result.bytes + shard.bytes,
      gzipBytes: result.gzipBytes + shard.gzipBytes,
      brotliBytes: result.brotliBytes + shard.brotliBytes,
    }),
    { bytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}

export async function buildZBSearchIndex({
  contentRoot = path.resolve('content/docs'),
  outputFile,
} = {}) {
  if (!outputFile) throw new Error('buildZBSearchIndex requires an outputFile.');

  const pages = await collectZBSearchSourceIndexes(contentRoot);
  const outputDirectory = path.dirname(outputFile);
  const searchDirectory = path.join(outputDirectory, 'search');
  await mkdir(outputDirectory, { recursive: true });
  await rm(searchDirectory, { recursive: true, force: true });
  await mkdir(searchDirectory, { recursive: true });

  const categoryData = new Map();
  const coreUnitsByCategory = new Map();
  const bodyUnitsByGroup = new Map();
  let bodyRecordCount = 0;

  for (const page of pages) {
    const coreRecord = buildZBSearchCoreIndex(page);
    const bodyRecords = buildZBSearchSectionIndexes(page);
    bodyRecordCount += bodyRecords.length;

    const category = categoryData.get(page.category) ?? {
      id: page.category,
      groups: new Set(),
      routingRecords: [],
    };
    category.groups.add(page.group);
    category.routingRecords.push(coreRecord, ...bodyRecords);
    categoryData.set(page.category, category);

    const coreUnits = coreUnitsByCategory.get(page.category) ?? [];
    coreUnits.push({
      key: page.url,
      records: [coreRecord],
      chars: recordSourceChars(coreRecord),
      category: page.category,
      group: page.category,
    });
    coreUnitsByCategory.set(page.category, coreUnits);

    const bodyUnit = {
      key: page.url,
      records: bodyRecords,
      chars: bodyRecords.reduce((sum, record) => sum + recordSourceChars(record), 0),
      category: page.category,
      group: page.group,
    };
    const groupUnits = bodyUnitsByGroup.get(page.group) ?? [];
    groupUnits.push(...splitLargePageUnit(bodyUnit));
    bodyUnitsByGroup.set(page.group, groupUnits);
  }

  const coreShards = [];
  for (const [category, units] of Array.from(coreUnitsByCategory.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const plans = splitStableUnits(units, ZBSEARCH_CORE_SOURCE_TARGET_CHARS);
    for (const plan of plans) {
      coreShards.push(
        ...(await writeRoutedShard({
          kind: 'core',
          records: plan.units.flatMap((unit) => unit.records),
          category,
          group: category,
          key: plan.key,
          searchDirectory,
        })),
      );
    }
  }

  const bodyShards = [];
  for (const [group, units] of Array.from(bodyUnitsByGroup.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const plans = splitStableUnits(units, ZBSEARCH_SOURCE_TARGET_CHARS);
    for (const plan of plans) {
      bodyShards.push(
        ...(await writeRoutedShard({
          kind: 'body',
          records: plan.units.flatMap((unit) => unit.records),
          category: plan.units[0]?.category ?? 'root',
          group,
          key: plan.key,
          searchDirectory,
        })),
      );
    }
  }

  const categories = Array.from(categoryData.values())
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((category) => ({
      id: category.id,
      groups: Array.from(category.groups).sort(),
      route: buildBloomRoute(category.routingRecords, {
        minBits: CATEGORY_BLOOM_MIN_BITS,
        maxBits: CATEGORY_BLOOM_MAX_BITS,
      }),
    }));

  const coreTotals = sumSizes(coreShards);
  const bodyTotals = sumSizes(bodyShards);
  const manifest = {
    version: SEARCH_MANIFEST_VERSION,
    engine: 'zbsearch',
    mode: SEARCH_MANIFEST_MODE,
    pages: pages.length,
    records: bodyRecordCount,
    routing: {
      algorithm: 'bloom-fnv-v1',
      tokenizer: 'cjk-bigram-latin-trigram-v1',
      minScore: 0.5,
    },
    categories,
    core: { ...coreTotals, shards: coreShards },
    body: { ...bodyTotals, shards: bodyShards },
  };

  const manifestJson = JSON.stringify(manifest);
  const manifestSizes = compressionSizes(manifestJson);
  if (manifestSizes.bytes >= ZBSEARCH_MAX_BYTES) {
    throw new Error(`Internal ZBSearch manifest is ${manifestSizes.bytes} bytes, above the EdgeOne limit.`);
  }
  await writeFile(outputFile, manifestJson);

  const total = {
    bytes: manifestSizes.bytes + coreTotals.bytes + bodyTotals.bytes,
    gzipBytes: manifestSizes.gzipBytes + coreTotals.gzipBytes + bodyTotals.gzipBytes,
    brotliBytes: manifestSizes.brotliBytes + coreTotals.brotliBytes + bodyTotals.brotliBytes,
  };

  console.log(
    `[zbsearch] Core: ${coreShards.length} routed shard(s), ${pages.length} page records; raw ${formatMiB(coreTotals.bytes)}, brotli ${formatMiB(coreTotals.brotliBytes)}.`,
  );
  console.log(
    `[zbsearch] Body: ${bodyShards.length} routed shard(s), ${bodyRecordCount} section chunks; raw ${formatMiB(bodyTotals.bytes)}, brotli ${formatMiB(bodyTotals.brotliBytes)}.`,
  );
  console.log(
    `[zbsearch] Category routing: ${categories.length} Bloom summaries; internal manifest ${formatMiB(manifestSizes.bytes)} raw.`,
  );

  for (const shard of [...coreShards, ...bodyShards]) {
    console.log(
      `[zbsearch] ${shard.url}: ${shard.records} records; raw ${formatMiB(shard.bytes)}; brotli ${formatMiB(shard.brotliBytes)}; route ${Math.round(shard.route.bits / 8 / 1024)} KiB.`,
    );
  }

  return {
    pages: pages.length,
    records: bodyRecordCount,
    categories,
    coreShards,
    bodyShards,
    core: coreTotals,
    body: bodyTotals,
    manifest: manifestSizes,
    ...total,
    outputFile,
  };
}

async function main() {
  const outputFile = path.resolve(process.argv[2] ?? 'public/search-index.json');
  const result = await buildZBSearchIndex({ outputFile });

  console.log(`[zbsearch] Indexed ${result.pages} pages into ${result.records} searchable section chunks.`);
  console.log(`[zbsearch] Total raw: ${formatMiB(result.bytes)}.`);
  console.log(`[zbsearch] Total gzip estimate: ${formatMiB(result.gzipBytes)}.`);
  console.log(`[zbsearch] Total Brotli estimate: ${formatMiB(result.brotliBytes)}.`);
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
