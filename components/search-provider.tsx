'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { ShardedSearchDialog } from './search-dialog';

/**
 * The production documentation is deployed as static CDN files only. Search
 * uses a small manifest plus multiple ZBSearch shards, all queried locally in
 * the browser with no search API or runtime function.
 */
export function SearchProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        SearchDialog: ShardedSearchDialog,
      }}
    >
      {children}
    </RootProvider>
  );
}
