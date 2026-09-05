import { getMDXComponents } from '@/components/mdx';
import { source } from '@/lib/source';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  PageLastUpdate,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';

type PageParameters = {
  params: Promise<{
    slug?: string[];
  }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

export default async function Page({ params }: PageParameters) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const data = await page.data.load();
  const MDX = data.body;
  const markdownUrl = `${page.url}.md`;

  return (
    <DocsPage toc={data.toc} full={page.data.full}>
      <DocsTitle className="font-medium">{page.data.title}</DocsTitle>
      <DocsDescription className="mb-1 font-normal">
        {page.data.description}
      </DocsDescription>
      <div id="docs-page-actions" className="flex items-center gap-2 border-b pb-6 pt-2">
        <MarkdownCopyButton
          markdownUrl={markdownUrl}
          className="docs-page-action"
        />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/ActiveInsighter/fumadocs-tecent/blob/main/content/docs/${page.path}`}
          className="docs-page-action"
        />
      </div>
      <DocsBody id="docs-body" className="pb-10 pt-4">
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      {data.lastModified && <PageLastUpdate date={data.lastModified} />}
    </DocsPage>
  );
}

export async function generateMetadata({
  params,
}: PageParameters): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
