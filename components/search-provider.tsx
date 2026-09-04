'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

/**
 * Search is intentionally disabled for the static CDN build. Keeping the
 * provider wrapper makes it trivial to re-enable Algolia or another search
 * implementation later without touching the root layout again.
 */
export function SearchProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        enabled: false,
      }}
    >
      {children}
    </RootProvider>
  );
}
