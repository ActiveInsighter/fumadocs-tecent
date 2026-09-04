/**
 * Configuration shared by the static documentation build and its tests.
 *
 * The regular application remains a hybrid Next.js application. This config
 * deliberately contains only features supported by Next.js static export.
 */
export function getStaticDocsConfig() {
  return {
    output: 'export',
    trailingSlash: true,
    images: {
      unoptimized: true,
    },
    experimental: {
      turbopackFileSystemCacheForBuild: true,
    },
  };
}

const dynamicRoutePrefixes = [
  'app/api',
  'app/download',
  // The markdown route handler caused file-lock issues during static export
  // on Windows; static markdown is generated directly from `content/docs`
  // by `scripts/static-docs-markdown.mjs` instead.
  'app/llms.mdx',
];

function isWithin(childPath, ancestorPath) {
  return childPath === ancestorPath || childPath.startsWith(`${ancestorPath}/`);
}

export function shouldIncludeInStaticDocsProject(relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/\/+$/, '');

  return !dynamicRoutePrefixes.some((prefix) => isWithin(normalizedPath, prefix));
}
