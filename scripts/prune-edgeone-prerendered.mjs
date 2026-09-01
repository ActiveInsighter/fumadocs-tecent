import { access, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prerenderedExtensions = new Set(['.html', '.meta', '.rsc']);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  if (!(await exists(directory))) return [];

  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(filePath)));
    } else if (
      entry.isFile() &&
      (prerenderedExtensions.has(path.extname(entry.name)) ||
        entry.name.endsWith('.prefetch.rsc'))
    ) {
      files.push(filePath);
    }
  }
  return files;
}

/**
 * EdgeOne's Next adapter copies prerendered App Router files to `.edgeone/assets`
 * but also leaves the same files in the SSR function bundle. Static requests
 * are handled by the assets route first, so the duplicate files are not needed
 * by the function and can exceed the direct-upload project size limit.
 */
export async function prunePrerenderedFiles({ assetsDir, serverAppDir }) {
  const candidates = await walk(serverAppDir);
  let removedCount = 0;
  let removedBytes = 0;

  for (const filePath of candidates) {
    const relativePath = path.relative(serverAppDir, filePath);
    const assetPath = path.join(assetsDir, relativePath);

    if (!(await exists(assetPath))) continue;

    removedBytes += (await stat(filePath)).size;
    await unlink(filePath);
    removedCount += 1;
  }

  return { removedCount, removedBytes };
}

async function main() {
  const projectRoot = process.cwd();
  const assetsDir = path.join(projectRoot, '.edgeone', 'assets');
  const serverAppDir = path.join(
    projectRoot,
    '.edgeone',
    'cloud-functions',
    'ssr-node',
    '.next',
    'server',
    'app',
  );

  const result = await prunePrerenderedFiles({ assetsDir, serverAppDir });
  const megabytes = (result.removedBytes / 1024 / 1024).toFixed(2);
  console.log(
    `[EdgeOne] Removed ${result.removedCount} duplicated prerendered files (${megabytes} MiB) from the SSR bundle.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[EdgeOne] Failed to prune duplicated prerendered files.', error);
    process.exitCode = 1;
  });
}
