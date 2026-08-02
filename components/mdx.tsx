import * as AccordionComponents from 'fumadocs-ui/components/accordion';
import { Callout } from 'fumadocs-ui/components/callout';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import * as FilesComponents from 'fumadocs-ui/components/files';
import * as StepsComponents from 'fumadocs-ui/components/steps';
import * as TabsComponents from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

type CalloutProps = ComponentProps<typeof Callout>;

function mergeClasses(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(' ');
}

/**
 * Global MDX component registry.
 *
 * The thin wrappers below keep Fumadocs' built-in behavior (Shiki, copy,
 * titles, line numbers and accessibility) while exposing project-owned class
 * names for maintainable styling in app/global.css.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...AccordionComponents,
    ...FilesComponents,
    ...StepsComponents,
    ...TabsComponents,
    TypeTable,
    Callout: ({ className, ...props }: CalloutProps) => (
      <Callout
        {...props}
        className={mergeClasses('docs-callout', className)}
      />
    ),
    pre: ({ ref: _ref, className, ...props }) => (
      <CodeBlock
        {...props}
        className={mergeClasses('docs-codeblock', className)}
        viewportProps={{ className: 'docs-codeblock-viewport' }}
      >
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
