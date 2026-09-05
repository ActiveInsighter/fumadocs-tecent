import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const staticStageRoot = path.join(projectRoot, '.static-docs-stage');
const staticSearchRoot = path.join(projectRoot, '.static-search-output');

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

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
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

function runProcess(command, args, { cwd, env, label }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[timing] ${label}=${formatSeconds(durationMs)}`);
        resolve({ durationMs });
        return;
      }

      reject(
        new Error(
          `${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`,
        ),
      );
    });
  });
}

function runNextBuild(stageRoot) {
  const nextCommand = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'next.cmd' : 'next',
  );

  return runProcess(nextCommand, ['build'], {
    cwd: stageRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      STATIC_DOCS_BUILD: '1',
    },
    label: 'next_static_build',
  });
}

async function runSearchBuild(outputRoot) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  return runProcess(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'build-search-index.mjs'), path.join(outputRoot, 'search-index.json')],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      label: 'zbsearch_build',
    },
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

async function copyDirectoryContents(sourceRoot, destinationRoot) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    await cp(sourcePath, destinationPath, { recursive: entry.isDirectory() });
  }
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

async function main() {
  const totalStartedAt = Date.now();
  const stageRoot = staticStageRoot;

  try {
    await cleanStagePreservingBuildCache(stageRoot);
    const cacheState = (await exists(path.join(stageRoot, '.next', 'cache')))
      ? 'warm candidate'
      : 'cold';
    console.log(`[static-docs] Turbopack cache state: ${cacheState}.`);

    const prepareStartedAt = Date.now();
    await prepareStage(stageRoot);
    console.log(`[timing] prepare_static_stage=${formatSeconds(Date.now() - prepareStartedAt)}`);

    // Search extraction and Next static rendering are independent reads of the
    // documentation corpus. Run them as separate OS processes on the same
    // runner so they can use different cores without paying Actions artifact
    // upload/download costs for the ~400 MiB static site.
    const parallelStartedAt = Date.now();
    const [nextTiming, searchTiming] = await Promise.all([
      runNextBuild(stageRoot),
      runSearchBuild(staticSearchRoot),
    ]);
    const parallelDurationMs = Date.now() - parallelStartedAt;
    console.log(`[timing] parallel_build_wall=${formatSeconds(parallelDurationMs)}`);
    console.log(
      `[timing] parallel_overlap_saved=${formatSeconds(
        Math.max(0, nextTiming.durationMs + searchTiming.durationMs - parallelDurationMs),
      )}`,
    );

    const assembleStartedAt = Date.now();
    await rm(staticOutputRoot, { recursive: true, force: true });
    await cp(path.join(stageRoot, 'out'), staticOutputRoot, { recursive: true });
    await copyDirectoryContents(staticSearchRoot, staticOutputRoot);
    console.log(`[timing] assemble_static_and_search=${formatSeconds(Date.now() - assembleStartedAt)}`);

    const markdownStartedAt = Date.now();
    const markdownCount = await generateStaticMarkdownRoutes(staticOutputRoot);
    console.log(`[timing] direct_markdown_build=${formatSeconds(Date.now() - markdownStartedAt)}`);

    const summaryStartedAt = Date.now();
    const summary = await summarizeOutput(staticOutputRoot);
    console.log(`[timing] static_output_scan=${formatSeconds(Date.now() - summaryStartedAt)}`);

    console.log(
      `[static-docs] Published ${summary.files} static files (${formatMiB(summary.bytes)}).`,
    );
    console.log(`[static-docs] Generated ${markdownCount} direct markdown routes.`);
    console.log(
      `[static-docs] Largest file: ${formatMiB(summary.largestFile.size)} ${path.relative(
        projectRoot,
        summary.largestFile.path,
      )}`,
    );
    console.log(`[timing] static_package_total=${formatSeconds(Date.now() - totalStartedAt)}`);
  } finally {
    await cleanStagePreservingBuildCache(stageRoot);
    await rm(staticSearchRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[static-docs] Build failed.', error);
  process.exitCode = 1;
});
