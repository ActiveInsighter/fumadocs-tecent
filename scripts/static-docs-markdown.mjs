import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Static markdown generation for the CDN documentation package.
 *
 * Replaces the dynamic `app/llms.mdx/docs/[[...slug]]` route handler during
 * static export: source files under `content/docs` are converted directly
 * into plain markdown documents published next to the HTML pages.
 */

function normalizeSourcePath(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function stripExtension(relativePath) {
  return relativePath.replace(/\.(md|mdx)$/i, '');
}

function collapseIndexSegment(relativePath) {
  return relativePath.replace(/(^|\/)index$/i, '');
}

/**
 * Map a source path (relative to `content/docs`) to the page URL
 * following Fumadocs conventions (`index` files collapse to the folder).
 */
export function getStaticDocsPageUrl(relativePath) {
  const slug = collapseIndexSegment(stripExtension(normalizeSourcePath(relativePath)));

  return `/docs${slug ? `/${slug}` : ''}`;
}

/**
 * Map a source path (relative to `content/docs`) to the static markdown
 * output path (relative to the export root), e.g. `math/index.mdx` ->
 * `docs/math.md`.
 */
export function getStaticMarkdownOutputPath(relativePath) {
  const slug = collapseIndexSegment(stripExtension(normalizeSourcePath(relativePath)));

  return `docs${slug ? `/${slug}` : ''}.md`;
}

export function splitFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: '', body: content };

  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

export function parseFrontmatterTitle(frontmatter) {
  const match = /^title:\s*(.+)$/m.exec(frontmatter);
  if (!match) return null;

  return match[1].trim().replace(/^["']|["']$/g, '').trim();
}

function countUnbalancedDelimiters(text) {
  let depth = 0;
  for (const character of text) {
    if (character === '{' || character === '(' || character === '[') depth += 1;
    if (character === '}' || character === ')' || character === ']') depth -= 1;
  }
  return depth;
}

function isJsxComponentLine(trimmedLine) {
  return /^<\/?[A-Z][\w.-]*(\s|>|\/>)/.test(trimmedLine);
}

function isCodeFenceLine(trimmedLine) {
  return /^(```|~~~)/.test(trimmedLine);
}

/**
 * Remove MDX module syntax (import/export statements) and block-level JSX
 * component usage while preserving markdown content, math delimiters, and
 * fenced code blocks untouched.
 */
export function stripMdxRuntimeSyntax(body) {
  const lines = body.split(/\r?\n/);
  const kept = [];
  let insideCodeFence = false;
  let statementDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isCodeFenceLine(trimmed)) {
      insideCodeFence = !insideCodeFence;
      kept.push(line);
      continue;
    }

    if (insideCodeFence) {
      kept.push(line);
      continue;
    }

    if (statementDepth > 0) {
      statementDepth += countUnbalancedDelimiters(line);
      if (statementDepth <= 0) statementDepth = 0;
      continue;
    }

    if (/^(import|export)[\s{(]/.test(trimmed)) {
      statementDepth = countUnbalancedDelimiters(line);
      continue;
    }

    if (isJsxComponentLine(trimmed)) continue;

    kept.push(line);
  }

  return kept.join('\n');
}

/**
 * Render a source document as a standalone markdown file, mirroring the
 * output format of `lib/get-llm-text.ts` used by the previous route handler.
 */
export async function renderStaticMarkdown(content, { title, url }) {
  const { body } = splitFrontmatter(content);
  const cleanedBody = stripMdxRuntimeSyntax(body).trim();

  return `# ${title} (${url})\n\n${cleanedBody}\n`;
}

/**
 * Read a source document and produce both its static output path and its
 * rendered markdown content.
 */
export async function buildStaticMarkdownDocument(sourcePath, relativePath) {
  const content = await readFile(sourcePath, 'utf8');
  const { frontmatter } = splitFrontmatter(content);
  const slug = collapseIndexSegment(stripExtension(normalizeSourcePath(relativePath)));
  const fallbackTitle = slug.split('/').pop() || 'Untitled';
  const title = parseFrontmatterTitle(frontmatter) ?? fallbackTitle;

  return {
    outputPath: getStaticMarkdownOutputPath(relativePath),
    markdown: await renderStaticMarkdown(content, {
      title,
      url: getStaticDocsPageUrl(relativePath),
    }),
  };
}

export function isStaticDocSourceFile(filePath) {
  return /\.(md|mdx)$/i.test(path.basename(filePath));
}
