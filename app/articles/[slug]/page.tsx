import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LanguageSwitcher } from '@/components/articles/language-switcher';
import {
  ARTICLE_IDS,
  articleCopy,
  getArticleLocale,
  getArticleSourceSlug,
  type ArticleLocale,
} from '@/lib/articles';
import { articleSource } from '@/lib/article-source';
import { getMDXComponents } from '@/components/mdx';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody } from 'fumadocs-ui/layouts/docs/page';

type PageParameters = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
};

function getArticle(slug: string, locale: ArticleLocale) {
  const page = articleSource.getPage(getArticleSourceSlug(slug, locale));
  if (!page) notFound();
  return page;
}

export default async function ArticlePage({
  params,
  searchParams,
}: PageParameters) {
  const { slug } = await params;
  const { lang } = await searchParams;
  const locale = getArticleLocale(lang);
  const copy = articleCopy[locale];
  const page = getArticle(slug, locale);
  const MDX = page.data.body;

  return (
    <main className="min-h-screen px-6 py-6 sm:px-10 sm:py-8">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b pb-5">
        <Link
          href="/"
          className="font-medium tracking-tight underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          Fumadocs Vercel
        </Link>
        <nav
          aria-label={copy.navArticles}
          className="flex w-full flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm text-fd-muted-foreground sm:w-auto"
        >
          <Link
            href="/articles"
            className="underline-offset-4 hover:text-fd-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {copy.navArticles}
          </Link>
          <Link
            href="/docs"
            className="underline-offset-4 hover:text-fd-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {copy.navDocs}
          </Link>
        </nav>
      </header>

      <article
        lang={locale === 'zh' ? 'zh-CN' : 'en'}
        className="mx-auto max-w-3xl pb-16 pt-12 sm:pb-24 sm:pt-20"
      >
        <Link
          href={`/articles?lang=${locale}`}
          className="text-sm text-fd-muted-foreground underline-offset-4 hover:text-fd-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          ← {copy.backToArticles}
        </Link>
        <header className="mt-10 border-b pb-8 sm:mt-14">
          <h1 className="font-article text-5xl leading-[0.98] tracking-tight sm:text-7xl">
            {page.data.title}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
            {page.data.description}
          </p>
          <div className="mt-8">
            <LanguageSwitcher articleId={slug} locale={locale} />
          </div>
        </header>
        <DocsBody id="article-body" className="article-content pb-10 pt-10">
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(articleSource, page),
            })}
          />
        </DocsBody>
      </article>
    </main>
  );
}

export function generateStaticParams() {
  return ARTICLE_IDS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
  searchParams,
}: PageParameters): Promise<Metadata> {
  const { slug } = await params;
  const { lang } = await searchParams;
  const locale = getArticleLocale(lang);
  const page = getArticle(slug, locale);

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
