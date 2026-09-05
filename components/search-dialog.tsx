'use client';

import type { SortedResult } from 'fumadocs-core/search';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useEffect, useRef, useState } from 'react';

interface SearchFile {
  url: string;
  records?: number;
  bytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

interface BloomRoute {
  bits: number;
  hashes: number;
  tokens: number;
  data: string;
}

interface RoutedSearchShard extends SearchFile {
  records: number;
  category: string;
  group: string;
  route: BloomRoute;
}

interface SearchCategory {
  id: string;
  groups: string[];
  shards: number;
  records: number;
  router: SearchFile;
}

interface SearchManifest {
  version: 3;
  engine: 'zbsearch';
  mode: 'tiered-category-router-shards';
  routing: {
    algorithm: 'bloom-fnv-v1';
    tokenizer: 'cjk-bigram-latin-trigram-v1';
    minScore: number;
  };
  core: {
    shards: SearchFile[];
  };
  body: {
    categories: SearchCategory[];
  };
}

interface CategoryRouter {
  version: 1;
  engine: 'zbsearch';
  category: string;
  shards: RoutedSearchShard[];
}

const SEARCH_DELAY_MS = 80;
const CATEGORY_BATCH = 2;
const INITIAL_BODY_BATCH = 3;
const MAX_CATEGORY_ROUTERS_PER_QUERY = 8;
const MAX_BODY_SHARDS_PER_QUERY = 9;
const BODY_RESULT_TARGET = 18;
const RESULT_LIMIT = 36;

let manifestPromise: Promise<SearchManifest> | undefined;
const routerPromiseCache = new Map<string, Promise<CategoryRouter>>();
const clientCache = new Map<string, ReturnType<typeof staticClient>>();
const bloomBytesCache = new Map<string, Uint8Array>();

function getStaticClient(url: string, limit: number) {
  const key = `${url}\u0000${limit}`;
  let client = clientCache.get(key);
  if (!client) {
    client = staticClient({
      from: url,
      search: { limit },
    });
    clientCache.set(key, client);
  }
  return client;
}

async function loadManifest() {
  // The manifest has a stable URL and points to content-addressed files, so it
  // must be revalidated after a deployment instead of being force-cached.
  const response = await fetch('/search-index.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ZBSearch manifest: HTTP ${response.status}`);
  }

  const manifest = (await response.json()) as SearchManifest;
  if (
    manifest.version !== 3 ||
    manifest.engine !== 'zbsearch' ||
    manifest.mode !== 'tiered-category-router-shards' ||
    !Array.isArray(manifest.core?.shards) ||
    manifest.core.shards.length === 0 ||
    !Array.isArray(manifest.body?.categories) ||
    manifest.body.categories.length === 0
  ) {
    throw new Error('Invalid ZBSearch manifest.');
  }
  return manifest;
}

function getManifest() {
  manifestPromise ??= loadManifest();
  return manifestPromise;
}

async function loadCategoryRouter(category: SearchCategory) {
  const response = await fetch(category.router.url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load search router ${category.id}: HTTP ${response.status}`);
  }

  const router = (await response.json()) as CategoryRouter;
  if (
    router.version !== 1 ||
    router.engine !== 'zbsearch' ||
    router.category !== category.id ||
    !Array.isArray(router.shards)
  ) {
    throw new Error(`Invalid search router for ${category.id}.`);
  }
  return router;
}

function getCategoryRouter(category: SearchCategory) {
  let promise = routerPromiseCache.get(category.router.url);
  if (!promise) {
    promise = loadCategoryRouter(category);
    routerPromiseCache.set(category.router.url, promise);
  }
  return promise;
}

function hash32(value: string, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hash32Secondary(value: string) {
  let hash = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x85ebca6b);
    hash ^= hash >>> 13;
  }
  return (hash | 1) >>> 0;
}

function routingTokens(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
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

function getBloomBytes(shard: RoutedSearchShard) {
  const cached = bloomBytesCache.get(shard.url);
  if (cached) return cached;

  const binary = atob(shard.route.data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  bloomBytesCache.set(shard.url, bytes);
  return bytes;
}

function bloomContains(shard: RoutedSearchShard, token: string) {
  const bytes = getBloomBytes(shard);
  const first = hash32(token);
  const second = hash32Secondary(token);
  const mask = shard.route.bits - 1;

  for (let index = 0; index < shard.route.hashes; index += 1) {
    const bit = (first + Math.imul(index, second)) & mask;
    if ((bytes[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function bloomScore(shard: RoutedSearchShard, tokens: string[]) {
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (bloomContains(shard, token)) matched += 1;
  }
  return matched / tokens.length;
}

function urlScope(url: string) {
  const pathname = url.split('#', 1)[0];
  const segments = pathname.replace(/^\/docs\/?/, '').split('/').filter(Boolean);
  const category = segments[0] ?? 'root';
  const group = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : category;
  return { category, group };
}

function currentScope() {
  return typeof window === 'undefined'
    ? { category: 'root', group: 'root' }
    : urlScope(window.location.pathname);
}

function mergeRoundRobin(groups: SortedResult[][], limit = RESULT_LIMIT) {
  const merged: SortedResult[] = [];
  const seen = new Set<string>();
  const maxLength = Math.max(0, ...groups.map((group) => group.length));

  for (let index = 0; index < maxLength && merged.length < limit; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

async function searchFiles(files: SearchFile[], query: string, limitPerFile: number) {
  const groups = await Promise.all(
    files.map((file) => getStaticClient(file.url, limitPerFile).search(query)),
  );
  return mergeRoundRobin(groups, RESULT_LIMIT);
}

function coreCategories(results: SortedResult[]) {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const result of results.slice(0, 12)) {
    const category = urlScope(result.url).category;
    if (seen.has(category)) continue;
    seen.add(category);
    ordered.push(category);
  }
  return ordered;
}

function rankCategories(manifest: SearchManifest, coreResults: SortedResult[]) {
  const scope = currentScope();
  const inferred = coreCategories(coreResults);
  const inferredRank = new Map(inferred.map((category, index) => [category, index]));

  return [...manifest.body.categories].sort((left, right) => {
    const score = (category: SearchCategory) => {
      let value = 0;
      if (category.id === scope.category && scope.category !== 'root') value += 100;
      const rank = inferredRank.get(category.id);
      if (rank !== undefined) value += 80 - rank * 5;
      if (category.id === 'root') value -= 5;
      value -= Math.min(category.router.brotliBytes / 1_000_000, 4);
      return value;
    };
    return score(right) - score(left);
  });
}

function rankBodyShards(
  shards: RoutedSearchShard[],
  query: string,
  minScore: number,
  coreResults: SortedResult[],
) {
  const tokens = routingTokens(query);
  const scope = currentScope();
  const inferred = new Set(coreCategories(coreResults));

  return shards
    .map((shard) => {
      const routeScore = bloomScore(shard, tokens);
      let score = routeScore * 2;
      if (shard.group === scope.group) score += 0.8;
      else if (shard.category === scope.category) score += 0.45;
      if (inferred.has(shard.category)) score += 0.3;
      score -= Math.min(shard.brotliBytes / 4_000_000, 0.2);
      return { shard, routeScore, score };
    })
    .filter((item) => {
      if (tokens.length === 0) {
        return item.shard.category === scope.category || inferred.has(item.shard.category);
      }
      return item.routeScore > 0 || item.shard.category === scope.category || inferred.has(item.shard.category);
    })
    .sort((left, right) => {
      const leftStrong = left.routeScore >= minScore ? 1 : 0;
      const rightStrong = right.routeScore >= minScore ? 1 : 0;
      if (leftStrong !== rightStrong) return rightStrong - leftStrong;
      if (left.score !== right.score) return right.score - left.score;
      return left.shard.brotliBytes - right.shard.brotliBytes;
    })
    .map((item) => item.shard);
}

function mergeCoreAndBody(core: SortedResult[], body: SortedResult[]) {
  return mergeRoundRobin([body, core], RESULT_LIMIT);
}

export function ShardedSearchDialog(props: SharedProps) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<SortedResult[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    const query = search.trim();

    if (!query) {
      setItems(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const manifest = await getManifest();
          if (requestRef.current !== requestId) return;

          const coreResults = await searchFiles(manifest.core.shards, query, 10);
          if (requestRef.current !== requestId) return;
          setItems(coreResults.length > 0 ? coreResults : null);

          const categoryQueue = rankCategories(manifest, coreResults);
          const candidateShards: RoutedSearchShard[] = [];
          const candidateUrls = new Set<string>();
          const searchedUrls = new Set<string>();
          let bodyResults: SortedResult[] = [];
          let categoryOffset = 0;

          while (
            categoryOffset < categoryQueue.length &&
            categoryOffset < MAX_CATEGORY_ROUTERS_PER_QUERY &&
            searchedUrls.size < MAX_BODY_SHARDS_PER_QUERY &&
            bodyResults.length < BODY_RESULT_TARGET
          ) {
            const categoryBatch = categoryQueue.slice(
              categoryOffset,
              categoryOffset + CATEGORY_BATCH,
            );
            categoryOffset += categoryBatch.length;

            const routers = await Promise.all(categoryBatch.map(getCategoryRouter));
            if (requestRef.current !== requestId) return;

            for (const router of routers) {
              const ranked = rankBodyShards(
                router.shards,
                query,
                manifest.routing.minScore,
                coreResults,
              );
              for (const shard of ranked) {
                if (candidateUrls.has(shard.url)) continue;
                candidateUrls.add(shard.url);
                candidateShards.push(shard);
              }
            }

            const nextShards = candidateShards
              .filter((shard) => !searchedUrls.has(shard.url))
              .slice(0, Math.min(INITIAL_BODY_BATCH, MAX_BODY_SHARDS_PER_QUERY - searchedUrls.size));

            if (nextShards.length === 0) continue;
            nextShards.forEach((shard) => searchedUrls.add(shard.url));

            const batchResults = await searchFiles(nextShards, query, 10);
            if (requestRef.current !== requestId) return;
            bodyResults = mergeRoundRobin([bodyResults, batchResults], RESULT_LIMIT);
            setItems(mergeCoreAndBody(coreResults, bodyResults));
          }

          setIsLoading(false);
        } catch (error) {
          if (requestRef.current !== requestId) return;
          console.error('[search] Failed to query local ZBSearch indexes.', error);
          setItems(null);
          setIsLoading(false);
        }
      })();
    }, SEARCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [search]);

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={items} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
