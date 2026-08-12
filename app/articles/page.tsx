import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LanguageSwitcher } from '@/components/articles/language-switcher';
import {
  ARTICLE_ID,
  articleCopy,
  getArticleLocale,
  getArticleSourceSlug,
  getArticleUrl,
  type ArticleLocale,
} from '@/lib/articles';
import { articleSource } from '@/lib/article-source';

type SearchParams = Promise<{
  lang?: string | string[];
}>;

function getArticle(locale: ArticleLocale) {
  const page = articleSource.getPage(getArticleSourceSlug(ARTICLE_ID, locale));
  if (!page) notFound();
  return page;
}

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { lang } = await searchParams;
  const locale = getArticleLocale(lang);
  const copy = articleCopy[locale];
  const article = getArticle(locale);

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
            href="/docs"
            className="underline-offset-4 hover:text-fd-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {copy.navDocs}
          </Link>
          <Link
            href="/"
            className="underline-offset-4 hover:text-fd-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {copy.navHome}
          </Link>
        </nav>
      </header>

      <div className="mx-auto max-w-5xl">
        <section className="grid gap-8 py-16 sm:grid-cols-[1fr_auto] sm:items-end sm:py-24">
          <div className="max-w-3xl">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.16em] text-fd-muted-foreground">
              {copy.listEyebrow}
            </p>
            <h1 className="font-article text-5xl leading-[0.95] tracking-tight sm:text-7xl">
              {copy.listTitle}
            </h1>
            <p className="mt-6 max-w-2xl whitespace-pre-line text-lg leading-8 text-fd-muted-foreground">
              {copy.listDescription}
            </p>
          </div>
          <div className="sm:justify-self-end">
            <LanguageSwitcher locale={locale} />
            <p className="mt-3 max-w-xs text-right text-xs leading-5 text-fd-muted-foreground">
              {copy.translationNote}
            </p>
          </div>
        </section>

        <section aria-labelledby="article-list-title" className="pb-16 sm:pb-24">
          <h2 id="article-list-title" className="sr-only">
            {copy.listTitle}
          </h2>
          <article className="group border-y py-8 sm:py-10">
            <div className="grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="max-w-3xl">
                <p className="mb-3 text-sm text-fd-muted-foreground">01</p>
                <h3 className="font-article text-3xl leading-tight tracking-tight sm:text-4xl">
                  {article.data.title}
                </h3>
                <p className="mt-4 max-w-2xl leading-7 text-fd-muted-foreground">
                  {article.data.description}
                </p>
              </div>
              <Link
                href={getArticleUrl(ARTICLE_ID, locale)}
                className="inline-flex h-10 w-fit items-center rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
              >
                {copy.readArticle}
                <span aria-hidden="true" className="ml-2">
                  →
                </span>
              </Link>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { lang } = await searchParams;
  const locale = getArticleLocale(lang);

  return {
    title: articleCopy[locale].listTitle,
    description: articleCopy[locale].listDescription,
  };
}
