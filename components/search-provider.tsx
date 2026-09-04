'use client';

import { liteClient } from 'algoliasearch/lite';
import AlgoliaSearchDialog from 'fumadocs-ui/components/dialog/search-algolia';
import DefaultSearchDialog from 'fumadocs-ui/components/dialog/search-default';
import type { DefaultSearchDialogProps } from 'fumadocs-ui/components/dialog/search-default';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { getAlgoliaSearchConfig } from '@/lib/algolia-search-config';

const algoliaConfig = getAlgoliaSearchConfig({
  appId: process.env.NEXT_PUBLIC_ALGOLIA_APP_ID,
  searchKey: process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY,
  indexName: process.env.NEXT_PUBLIC_ALGOLIA_INDEX_NAME,
});

const algoliaSearchClient = algoliaConfig
  ? liteClient(algoliaConfig.appId, algoliaConfig.searchKey)
  : null;

/**
 * Keep the existing static search as a local fallback until Algolia's public
 * build-time settings have been configured.
 */
function SearchDialog({ type, api, delayMs, ...props }: DefaultSearchDialogProps) {
  if (!algoliaConfig || !algoliaSearchClient) {
    return (
      <DefaultSearchDialog
        {...props}
        type={type ?? 'static'}
        api={api}
        delayMs={delayMs}
      />
    );
  }

  return (
    <AlgoliaSearchDialog
      {...props}
      showAlgolia
      searchOptions={{
        client: algoliaSearchClient,
        indexName: algoliaConfig.indexName,
      }}
    />
  );
}

export function SearchProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        SearchDialog,
        options: {
          // The wrapper chooses Algolia when configured and keeps the static
          // Fumadocs index available for local development and previews.
          type: 'static',
        },
      }}
    >
      {children}
    </RootProvider>
  );
}
