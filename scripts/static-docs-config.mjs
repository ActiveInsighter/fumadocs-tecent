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

// `app/api/search` 以静态方式导出搜索索引（staticGET + revalidate = false），
// 是纯静态站点唯一需要保留的 API 路由。
const staticRouteExceptions = ['app/api/search'];

function isWithin(childPath, ancestorPath) {
  return childPath === ancestorPath || childPath.startsWith(`${ancestorPath}/`);
}

export function shouldIncludeInStaticDocsProject(relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/\/+$/, '');

  if (staticRouteExceptions.some((exception) => isWithin(normalizedPath, exception))) {
    return true;
  }

  // 保留例外的祖先目录（如 `app/api`），否则 `cp` 在目录级过滤时
  // 不会递归进入，例外的路由文件就永远访问不到。
  if (staticRouteExceptions.some((exception) => isWithin(exception, normalizedPath))) {
    return true;
  }

  return !dynamicRoutePrefixes.some((prefix) => isWithin(normalizedPath, prefix));
}
