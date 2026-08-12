import Link from 'next/link';
import {
  ARTICLE_LOCALES,
  articleCopy,
  type ArticleLocale,
  getArticleListUrl,
  getArticleUrl,
} from '@/lib/articles';

const localeLabels: Record<ArticleLocale, Record<ArticleLocale, string>> = {
  en: {
    en: 'English',
    zh: '中文',
    bilingual: 'Bilingual',
  },
  zh: {
    en: '英文',
    zh: '中文',
    bilingual: '中英对照',
  },
  bilingual: {
    en: 'English / 英文',
    zh: '中文 / Chinese',
    bilingual: '中英对照 / Bilingual',
  },
};

type LanguageSwitcherProps = {
  articleId?: string;
  locale: ArticleLocale;
};

export function LanguageSwitcher({
  articleId,
  locale,
}: LanguageSwitcherProps) {
  const copy = articleCopy[locale];

  return (
    <nav
      aria-label={copy.languageLabel}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="mr-1 text-fd-muted-foreground">{copy.languageLabel}</span>
      {ARTICLE_LOCALES.map((option) => {
        const label = localeLabels[locale][option];
        const href = articleId
          ? getArticleUrl(articleId, option)
          : getArticleListUrl(option);

        return option === locale ? (
          <span
            key={option}
            aria-current="page"
            className="rounded-md bg-fd-primary px-3 py-1.5 font-medium text-fd-primary-foreground"
          >
            {label}
          </span>
        ) : (
          <Link
            key={option}
            href={href}
            className="rounded-md px-3 py-1.5 text-fd-muted-foreground underline-offset-4 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
