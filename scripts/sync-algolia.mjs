import nextEnv from '@next/env';
import { algoliasearch } from 'algoliasearch';
import { sync } from 'fumadocs-core/search/algolia';
import { collectAlgoliaDocuments } from './algolia-index.mjs';

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

function requiredEnvironment(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : '');
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function main() {
  const appId = requiredEnvironment('ALGOLIA_APP_ID', 'NEXT_PUBLIC_ALGOLIA_APP_ID');
  const adminApiKey = requiredEnvironment('ALGOLIA_ADMIN_API_KEY');
  const indexName =
    process.env.ALGOLIA_INDEX_NAME?.trim() ||
    process.env.NEXT_PUBLIC_ALGOLIA_INDEX_NAME?.trim() ||
    'docs';
  const documents = await collectAlgoliaDocuments();

  if (documents.length === 0) {
    throw new Error('No Markdown or MDX documents found under content/docs.');
  }

  await sync(algoliasearch(appId, adminApiKey), {
    indexName,
    documents,
  });

  console.log(
    `[algolia] Synced ${documents.length} documents to index "${indexName}".`,
  );
}

main().catch((error) => {
  console.error('[algolia] Sync failed.', error);
  process.exitCode = 1;
});
