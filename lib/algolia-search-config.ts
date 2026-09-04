export interface AlgoliaSearchConfigInput {
  appId?: string;
  searchKey?: string;
  indexName?: string;
}

export interface AlgoliaSearchConfig {
  appId: string;
  searchKey: string;
  indexName: string;
}

/**
 * Return a usable public Algolia configuration, or null when the app should
 * use its local Fumadocs search implementation instead.
 */
export function getAlgoliaSearchConfig(
  input: AlgoliaSearchConfigInput,
): AlgoliaSearchConfig | null {
  const appId = input.appId?.trim();
  const searchKey = input.searchKey?.trim();
  const indexName = input.indexName?.trim();

  if (!appId || !searchKey || !indexName) return null;

  return { appId, searchKey, indexName };
}
