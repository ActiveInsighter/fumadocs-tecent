import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shouldIncludeInStaticDocsProject } from './static-docs-config.mjs';
import {
  buildStaticMarkdownDocument,
  isStaticDocSourceFile,
} from './static-docs-markdown.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const staticOutputRoot = path.join(projectRoot, '.static-docs');
const persistentBuildCacheRoot = path.join(projectRoot, '.static-docs-next-cache');

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

async function prepareStage(stageRoot) {
  for (const entry of projectEntries) {
    await copyProjectEntry(stageRoot, entry);
  }

  await cp(
    path.join(projectRoot, 'scripts', 'static-root-layout.tsx'),
    path.join(stageRoot, 'app', 'layout.tsx'),
  );

  await cp(
    path.join(projectRoot, 'next.config.static.mjs'),
    path.join(stageRoot, 'next.config.mjs'),
  );
  await cp(
    path.join(projectRoot, 'scripts', 'static-docs-config.mjs'),
    path.join(stageRoot, 'scripts', 'static-docs-config.mjs'),
  );
}

async function restoreBuildCache(stageRoot) {
  if (!(await exists(persistentBuildCacheRoot))) {
    console.log('[static-docs] No persisted Next/Turbopack cache found; cold build.');
    return;
  }

  const destination = path.join(stageRoot, '.next', 'cache');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(persistentBuildCacheRoot, destination, { recursive: true });
  console.log('[static-docs] Restored persisted Next/Turbopack cache.');
}

async function persistBuildCache(stageRoot) {
  const source = path.join(stageRoot, '.next', 'cache');
  if (!(await exists(source))) {
    console.log('[static-docs] Next/Turbopack cache directory was not produced.');
    return;
  }

  await rm(persistentBuildCacheRoot, { recursive: true, force: true });
  await mkdir(path.dirname(persistentBuildCacheRoot), { recursive: true });
  await cp(source, persistentBuildCacheRoot, { recursive: true });
  console.log('[static-docs] Persisted Next/Turbopack cache for the next build.');
}

async function removeStage(stageRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(stageRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
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

/**
 * Static export does not support Next rewrites, and the markdown route
 * handler is excluded from the static project entirely (Windows file-lock
 * issues with the extensionless route output). Instead, publish direct
 * /docs/*.md files beside the HTML pages by converting the sources under
 * content/docs directly.
 */
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

async function main() {
  const stageRoot = await mkdtemp(path.join(projectRoot, '.static-docs-stage-'));

  try {
    await prepareStage(stageRoot);
    await restoreBuildCache(stageRoot);
    await runNextBuild(stageRoot);
    await persistBuildCache(stageRoot);

    await rm(staticOutputRoot, { recursive: true, force: true });
    await cp(path.join(stageRoot, 'out'), staticOutputRoot, { recursive: true });
    const markdownCount = await generateStaticMarkdownRoutes(staticOutputRoot);
    const summary = await summarizeOutput(staticOutputRoot);

    console.log(
      `[static-docs] Published ${summary.files} static files (${(summary.bytes / 1024 / 1024).toFixed(2)} MiB).`,
    );
    console.log(`[static-docs] Generated ${markdownCount} direct markdown routes.`);
    console.log(
      `[static-docs] Largest file: ${(
        summary.largestFile.size / 1024 / 1024
      ).toFixed(2)} MiB ${path.relative(projectRoot, summary.largestFile.path)}`,
    );
  } finally {
    await removeStage(stageRoot);
  }
}

main().catch((error) => {
  console.error('[static-docs] Build failed.', error);
  process.exitCode = 1;
});
