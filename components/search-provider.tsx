'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

/**
 * The production documentation is deployed as static CDN files only. Use
 * Fumadocs' built-in ZBSearch static client so search runs entirely in the
 * browser after downloading the generated /search-index.json file.
 */
export function SearchProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        options: {
          type: 'static',
          api: '/search-index.json',
          delayMs: 80,
        },
      }}
    >
      {children}
    </RootProvider>
  );
}
