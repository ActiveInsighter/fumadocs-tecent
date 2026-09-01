import { access, readdir, rm, stat, unlink } from 'node:fs/promises';
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

  const files = await walkFiles(directory);
  return files.filter(
    (filePath) =>
      prerenderedExtensions.has(path.extname(filePath)) ||
      path.basename(filePath).endsWith('.prefetch.rsc'),
  );
}

async function walkFiles(directory) {
  if (!(await exists(directory))) return [];

  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(filePath)));
    } else if (entry.isFile()) {
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

/**
 * Next includes the optional sharp packages in the standalone server even
 * when image optimization is disabled. This app does not use next/image, so
 * those packages are not needed by the deployed SSR function.
 */
export async function pruneUnusedImageOptimizerPackages({ serverRoot }) {
  const imagePackagesRoot = path.join(serverRoot, 'node_modules', '@img');
  const candidates = [
    path.join(serverRoot, 'node_modules', 'sharp'),
    path.join(imagePackagesRoot, 'colour'),
  ];

  if (await exists(imagePackagesRoot)) {
    for (const entry of await readdir(imagePackagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('sharp-')) {
        candidates.push(path.join(imagePackagesRoot, entry.name));
      }
    }
  }

  let removedCount = 0;
  let removedBytes = 0;

  for (const packagePath of candidates) {
    if (!(await exists(packagePath))) continue;

    const files = await walkFiles(packagePath);
    removedBytes += (await Promise.all(files.map((filePath) => stat(filePath)))).reduce(
      (total, file) => total + file.size,
      0,
    );
    await rm(packagePath, { recursive: true, force: true });
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
  const serverRoot = path.join(
    projectRoot,
    '.edgeone',
    'cloud-functions',
    'ssr-node',
  );

  const result = await prunePrerenderedFiles({ assetsDir, serverAppDir });
  const imageResult = await pruneUnusedImageOptimizerPackages({ serverRoot });
  const megabytes = (result.removedBytes / 1024 / 1024).toFixed(2);
  const imageMegabytes = (imageResult.removedBytes / 1024 / 1024).toFixed(2);
  console.log(
    `[EdgeOne] Removed ${result.removedCount} duplicated prerendered files (${megabytes} MiB) from the SSR bundle.`,
  );
  console.log(
    `[EdgeOne] Removed ${imageResult.removedCount} unused image optimizer packages (${imageMegabytes} MiB) from the SSR bundle.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[EdgeOne] Failed to prune duplicated prerendered files.', error);
    process.exitCode = 1;
  });
}
