import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shouldIncludeInStaticDocsProject } from './static-docs-config.mjs';
import {
  buildStaticMarkdownDocument,
  isStaticDocSourceFile,
} from './static-docs-markdown.mjs';
import { buildZBSearchIndex } from './zbsearch-index.mjs';
import { finalizeSearchManifest } from './search-manifest.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const staticOutputRoot = path.join(projectRoot, '.static-docs');
const staticStageRoot = path.join(projectRoot, '.static-docs-stage');

const projectEntries = [
  'app',
  'components',
  'content',
  'lib',
  'public',
  '.source',
  'next-env.d.ts',
  'package.json',
  'postcss.config.mjs',
  'source.config.ts',
  'tsconfig.json',
];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyProjectEntry(stageRoot, relativePath) {
  const sourcePath = path.join(projectRoot, relativePath);
  if (!(await exists(sourcePath))) return;

  const destinationPath = path.join(stageRoot, relativePath);
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) {
    await cp(sourcePath, destinationPath, {
      recursive: true,
      filter: (candidatePath) => {
        const candidateRelativePath = path.relative(projectRoot, candidatePath);
        return shouldIncludeInStaticDocsProject(candidateRelativePath);
      },
    });
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath);
}

async function cleanStagePreservingBuildCache(stageRoot) {
  await mkdir(stageRoot, { recursive: true });

  for (const entry of await readdir(stageRoot, { withFileTypes: true })) {
    if (entry.name === '.next') continue;
    await rm(path.join(stageRoot, entry.name), { recursive: true, force: true });
  }

  const nextRoot = path.join(stageRoot, '.next');
  if (!(await exists(nextRoot))) return;

  for (const entry of await readdir(nextRoot, { withFileTypes: true })) {
    if (entry.name === 'cache') continue;
    await rm(path.join(nextRoot, entry.name), { recursive: true, force: true });
  }
}

async function prepareStage(stageRoot) {
  for (const entry of projectEntries) {
    await copyProjectEntry(stageRoot, entry);
  }

  await cp(
    path.join(projectRoot, 'scripts', 'static-root-layout.tsx'),
    path.join(stageRoot, 'app', 'layout.tsx'),
  );

  await mkdir(path.join(stageRoot, 'scripts'), { recursive: true });
  await cp(
    path.join(projectRoot, 'next.config.static.mjs'),
    path.join(stageRoot, 'next.config.mjs'),
  );
  await cp(
    path.join(projectRoot, 'scripts', 'static-docs-config.mjs'),
    path.join(stageRoot, 'scripts', 'static-docs-config.mjs'),
  );
}

function runNextBuild(stageRoot) {
  const nextCommand = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'next.cmd' : 'next',
  );

  return new Promise((resolve, reject) => {
    const child = spawn(nextCommand, ['build'], {
      cwd: stageRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        STATIC_DOCS_BUILD: '1',
      },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Static documentation build failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`,
        ),
      );
    });
  });
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

async function generateStaticMarkdownRoutes(outputRoot) {
  const contentRoot = path.join(projectRoot, 'content', 'docs');
  const sourceFiles = (await walkFiles(contentRoot)).filter((filePath) =>
    isStaticDocSourceFile(filePath),
  );

  let writtenCount = 0;

  for (const sourcePath of sourceFiles) {
    const relativePath = path.relative(contentRoot, sourcePath).replaceAll('\\', '/');
    const { outputPath, markdown } = await buildStaticMarkdownDocument(sourcePath, relativePath);
    const destinationPath = path.join(outputRoot, outputPath);

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, markdown);
    writtenCount += 1;
  }

  if (writtenCount === 0) {
    throw new Error('No documentation sources found for static markdown generation.');
  }

  return writtenCount;
}

async function summarizeOutput(outputRoot) {
  const files = await walkFiles(outputRoot);
  let bytes = 0;
  let largestFile = null;

  for (const filePath of files) {
    const size = (await stat(filePath)).size;
    bytes += size;
    if (!largestFile || size > largestFile.size) {
      largestFile = { path: filePath, size };
    }
  }

  return {
    bytes,
    files: files.length,
    largestFile,
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const stageRoot = staticStageRoot;

  try {
    await cleanStagePreservingBuildCache(stageRoot);
    const cacheState = (await exists(path.join(stageRoot, '.next', 'cache')))
      ? 'warm candidate'
      : 'cold';
    console.log(`[static-docs] Turbopack cache state: ${cacheState}.`);

    await prepareStage(stageRoot);
    await runNextBuild(stageRoot);

    await rm(staticOutputRoot, { recursive: true, force: true });
    await cp(path.join(stageRoot, 'out'), staticOutputRoot, { recursive: true });

    const searchManifestFile = path.join(staticOutputRoot, 'search-index.json');
    const searchIndex = await buildZBSearchIndex({
      contentRoot: path.join(projectRoot, 'content', 'docs'),
      outputFile: searchManifestFile,
    });
    const searchRouting = await finalizeSearchManifest({
      manifestFile: searchManifestFile,
    });

    const markdownCount = await generateStaticMarkdownRoutes(staticOutputRoot);
    const summary = await summarizeOutput(staticOutputRoot);

    console.log(
      `[static-docs] Published ${summary.files} static files (${formatMiB(summary.bytes)}).`,
    );
    console.log(`[static-docs] Generated ${markdownCount} direct markdown routes.`);
    console.log(
      `[static-docs] ZBSearch: ${searchIndex.pages} pages; ${searchIndex.bodyShards.length} body shards; raw ${formatMiB(
        searchIndex.bytes,
      )}; brotli ${formatMiB(searchIndex.brotliBytes)}.`,
    );
    console.log(
      `[static-docs] Search routing: ${searchRouting.categories} category routers; public manifest ${formatMiB(
        searchRouting.manifest.bytes,
      )}.`,
    );
    console.log(
      `[static-docs] Largest file: ${formatMiB(summary.largestFile.size)} ${path.relative(
        projectRoot,
        summary.largestFile.path,
      )}`,
    );
  } finally {
    await cleanStagePreservingBuildCache(stageRoot);
  }
}

main().catch((error) => {
  console.error('[static-docs] Build failed.', error);
  process.exitCode = 1;
});
