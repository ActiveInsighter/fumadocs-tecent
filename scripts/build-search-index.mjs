import path from 'node:path';
import { buildZBSearchIndex } from './zbsearch-index.mjs';
import { finalizeSearchManifest } from './search-manifest.mjs';

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const outputFile = path.resolve(process.argv[2] ?? 'public/search-index.json');
  const index = await buildZBSearchIndex({ outputFile });
  const routing = await finalizeSearchManifest({ manifestFile: outputFile });

  console.log(
    `[search] ${index.pages} pages, ${index.records} body records, ${index.coreShards.length} core shard(s), ${index.bodyShards.length} body shard(s).`,
  );
  console.log(
    `[search] Public manifest ${formatMiB(routing.manifest.bytes)} raw; ${routing.categories} category router(s), ${formatMiB(routing.routerTotals.bytes)} router metadata raw.`,
  );
}

main().catch((error) => {
  console.error('[search] Failed to build scalable static search.', error);
  process.exitCode = 1;
});
