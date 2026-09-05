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
  route: BloomRoute;
  coreShards: number;
  bodyShards: number;
  records: number;
  router: SearchFile;
}

interface SearchManifest {
  version: 4;
  engine: 'zbsearch';
  mode: 'category-bloom-router-shards';
  routing: {
    algorithm: 'bloom-fnv-v1';
    tokenizer: 'cjk-bigram-latin-trigram-v1';
    minScore: number;
  };
  categories: SearchCategory[];
}

interface CategoryRouter {
  version: 2;
  engine: 'zbsearch';
  category: string;
  core: RoutedSearchShard[];
  body: RoutedSearchShard[];
}

const SEARCH_DELAY_MS = 80;
const MAX_CATEGORY_ROUTERS_PER_QUERY = 4;
const MAX_CORE_SHARDS_PER_QUERY = 6;
const MAX_BODY_SHARDS_PER_QUERY = 9;
const RESULT_LIMIT = 36;

let manifestPromise: Promise<SearchManifest> | undefined;
const routerPromiseCache = new Map<string, Promise<CategoryRouter>>();
const clientCache = new Map<string, ReturnType<typeof staticClient>>();
const bloomBytesCache = new Map<string, Uint8Array>();

const MODULE_CATEGORIES = {
  politics: new Set(['politics']),
  english: new Set(['english']),
  math: new Set(['math', 'math-question-types']),
  professional: new Set(['408']),
} as const;

function getStaticClient(url: string, limit: number) {
  const key = `${url}\u0000${limit}`;
  let client = clientCache.get(key);
  if (!client) {
    client = staticClient({ from: url, search: { limit } });
    clientCache.set(key, client);
  }
  return client;
}

async function loadManifest() {
  const response = await fetch('/search-index.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ZBSearch manifest: HTTP ${response.status}`);
  }

  const manifest = (await response.json()) as SearchManifest;
  if (
    manifest.version !== 4 ||
    manifest.engine !== 'zbsearch' ||
    manifest.mode !== 'category-bloom-router-shards' ||
    !Array.isArray(manifest.categories) ||
    manifest.categories.length === 0
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
    router.version !== 2 ||
    router.engine !== 'zbsearch' ||
    router.category !== category.id ||
    !Array.isArray(router.core) ||
    !Array.isArray(router.body)
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

function getBloomBytes(cacheKey: string, route: BloomRoute) {
  const cached = bloomBytesCache.get(cacheKey);
  if (cached) return cached;

  const binary = atob(route.data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  bloomBytesCache.set(cacheKey, bytes);
  return bytes;
}

function bloomContains(cacheKey: string, route: BloomRoute, token: string) {
  const bytes = getBloomBytes(cacheKey, route);
  const first = hash32(token);
  const second = hash32Secondary(token);
  const mask = route.bits - 1;

  for (let index = 0; index < route.hashes; index += 1) {
    const bit = (first + Math.imul(index, second)) & mask;
    if ((bytes[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function bloomScore(cacheKey: string, route: BloomRoute, tokens: string[]) {
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (bloomContains(cacheKey, route, token)) matched += 1;
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

function currentModuleCategories() {
  const { category } = currentScope();
  if (category === 'politics') return MODULE_CATEGORIES.politics;
  if (category === 'english') return MODULE_CATEGORIES.english;
  if (category === 'math' || category === 'math-question-types') {
    return MODULE_CATEGORIES.math;
  }
  if (category === '408') return MODULE_CATEGORIES.professional;
  return null;
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

function rankCategories(manifest: SearchManifest, query: string) {
  const tokens = routingTokens(query);
  const scope = currentScope();
  const allowed = currentModuleCategories();

  return manifest.categories
    .filter((category) => !allowed || allowed.has(category.id))
    .map((category) => {
      const routeScore = bloomScore(`category:${category.id}`, category.route, tokens);
      let score = routeScore * 4;
      if (category.id === scope.category && scope.category !== 'root') score += 2;
      if (category.groups.includes(scope.group)) score += 1;
      score -= Math.min(category.router.brotliBytes / 1_000_000, 0.2);
      return { category, routeScore, score };
    })
    .sort((left, right) => {
      const leftStrong = left.routeScore >= manifest.routing.minScore ? 1 : 0;
      const rightStrong = right.routeScore >= manifest.routing.minScore ? 1 : 0;
      if (leftStrong !== rightStrong) return rightStrong - leftStrong;
      return right.score - left.score;
    })
    .slice(0, allowed ? allowed.size : MAX_CATEGORY_ROUTERS_PER_QUERY)
    .map((item) => item.category);
}

function rankShards(
  shards: RoutedSearchShard[],
  query: string,
  minScore: number,
  limit: number,
) {
  const tokens = routingTokens(query);
  const scope = currentScope();

  return shards
    .map((shard) => {
      const routeScore = bloomScore(shard.url, shard.route, tokens);
      let score = routeScore * 3;
      if (shard.group === scope.group) score += 1;
      else if (shard.category === scope.category) score += 0.5;
      score -= Math.min(shard.brotliBytes / 4_000_000, 0.2);
      return { shard, routeScore, score };
    })
    .filter((item) => tokens.length === 0 || item.routeScore > 0 || item.shard.category === scope.category)
    .sort((left, right) => {
      const leftStrong = left.routeScore >= minScore ? 1 : 0;
      const rightStrong = right.routeScore >= minScore ? 1 : 0;
      if (leftStrong !== rightStrong) return rightStrong - leftStrong;
      if (left.score !== right.score) return right.score - left.score;
      return left.shard.brotliBytes - right.shard.brotliBytes;
    })
    .slice(0, limit)
    .map((item) => item.shard);
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

          const categories = rankCategories(manifest, query);
          const routers = await Promise.all(categories.map(getCategoryRouter));
          if (requestRef.current !== requestId) return;

          const coreShards = rankShards(
            routers.flatMap((router) => router.core),
            query,
            manifest.routing.minScore,
            MAX_CORE_SHARDS_PER_QUERY,
          );
          const bodyShards = rankShards(
            routers.flatMap((router) => router.body),
            query,
            manifest.routing.minScore,
            MAX_BODY_SHARDS_PER_QUERY,
          );

          const coreResults = await searchFiles(coreShards, query, 10);
          if (requestRef.current !== requestId) return;
          setItems(coreResults.length > 0 ? coreResults : null);

          const bodyResults = await searchFiles(bodyShards, query, 10);
          if (requestRef.current !== requestId) return;

          const merged = mergeRoundRobin([bodyResults, coreResults], RESULT_LIMIT);
          setItems(merged.length > 0 ? merged : null);
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
