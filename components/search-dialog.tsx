'use client';

import type { SearchClient } from 'fumadocs-core/search/client';
import { useDocsSearch } from 'fumadocs-core/search/client';
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

interface SearchManifest {
  version: number;
  engine: 'zbsearch';
  mode: 'simple-section-shards';
  shards: string[];
}

let clientsPromise: Promise<SearchClient[]> | undefined;

async function loadShardClients() {
  const response = await fetch('/search-index.json');
  if (!response.ok) {
    throw new Error(`Failed to load ZBSearch manifest: HTTP ${response.status}`);
  }

  const manifest = (await response.json()) as SearchManifest;
  if (
    manifest.version !== 1 ||
    manifest.engine !== 'zbsearch' ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length === 0
  ) {
    throw new Error('Invalid ZBSearch manifest.');
  }

  return manifest.shards.map((from) =>
    staticClient({
      from,
      search: {
        limit: 12,
      },
    }),
  );
}

function getShardClients() {
  clientsPromise ??= loadShardClients();
  return clientsPromise;
}

const shardedZBSearchClient: SearchClient = {
  deps: [],
  async search(query) {
    const clients = await getShardClients();
    const groups = await Promise.all(clients.map((client) => client.search(query)));
    const merged = [];
    const seen = new Set<string>();
    const maxLength = Math.max(0, ...groups.map((group) => group.length));

    // staticClient intentionally exposes normalized results without internal
    // scores, so interleave each shard's ranked hits rather than letting one
    // shard always dominate the result list.
    for (let index = 0; index < maxLength; index += 1) {
      for (const group of groups) {
        const item = group[index];
        if (!item) continue;

        const key = item.url;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    return merged.slice(0, 36);
  },
};

export function ShardedSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    client: shardedZBSearchClient,
    delayMs: 80,
  });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
