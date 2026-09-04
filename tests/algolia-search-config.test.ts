import { describe, expect, it } from 'vitest';
import { getAlgoliaSearchConfig } from '../lib/algolia-search-config';

describe('getAlgoliaSearchConfig', () => {
  it('returns a normalized public configuration when all values are present', () => {
    expect(
      getAlgoliaSearchConfig({
        appId: '  demo-app  ',
        searchKey: '  demo-search-key  ',
        indexName: '  docs  ',
      }),
    ).toEqual({
      appId: 'demo-app',
      searchKey: 'demo-search-key',
      indexName: 'docs',
    });
  });

  it('falls back to the local search when any required value is missing', () => {
    expect(
      getAlgoliaSearchConfig({
        appId: 'demo-app',
        searchKey: 'demo-search-key',
      }),
    ).toBeNull();
  });

  it('treats whitespace-only values as missing', () => {
    expect(
      getAlgoliaSearchConfig({
        appId: 'demo-app',
        searchKey: '   ',
        indexName: 'docs',
      }),
    ).toBeNull();
  });
});
