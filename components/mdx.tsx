import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

/**
 * 统一管理 MDX 标签和自定义组件的渲染映射。
 *
 * 样式控制关系：
 * 1. defaultMdxComponents 把普通 Markdown 标签映射为 Fumadocs 组件，
 *    例如链接、图片、表格、代码块、Callout 和 Card。
 * 2. 这些组件的基础外观来自 app/global.css 中导入的
 *    `fumadocs-ui/css/preset.css`。
 * 3. app/docs/[[...slug]]/page.tsx 外层的 <DocsBody> 会添加 `.prose`，
 *    因此标题、段落、列表、引用、表格等排版可在 `.prose` 下统一覆盖。
 * 4. 最后的 `...components` 优先级最高，页面可以按需替换任意标签或组件。
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    // Fumadocs 默认 MDX 渲染器，是普通 Markdown 获得官方样式的核心。
    ...defaultMdxComponents,

    // 调用方传入的映射最后展开，确保自定义组件可以覆盖默认实现。
    ...components,
  } satisfies MDXComponents;
}

// 兼容 MDX Provider 约定，使全局和页面级渲染都使用同一套映射。
export const useMDXComponents = getMDXComponents;

declare global {
  // 为 MDX 文件中的全局组件提供 TypeScript 类型提示。
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
