import { getMDXComponents } from '@/components/mdx';
import { DocumentDownloadMenu } from '@/components/document-download-menu';
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
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';

type PageParameters = {
  params: Promise<{
    slug?: string[];
  }>;
};

export default async function Page({ params }: PageParameters) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = `${page.url}.md`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle className="font-medium">{page.data.title}</DocsTitle>
      <DocsDescription className="mb-1 font-normal">
        {page.data.description}
      </DocsDescription>
      <div className="flex items-center gap-2 border-b pb-6 pt-2">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/ActiveInsighter/fumadocs-tecent/blob/main/content/docs/${page.path}`}
        />
        {page.data.taskRecordId && page.data.messageRecordId && page.data.documentVersion ? (
          <DocumentDownloadMenu
            taskRecordId={page.data.taskRecordId}
            messageRecordId={page.data.messageRecordId}
            version={page.data.documentVersion}
          />
        ) : null}
      </div>
      <DocsBody id="docs-body" className="pb-10 pt-4">
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
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
