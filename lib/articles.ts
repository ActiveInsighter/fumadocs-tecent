export const ARTICLE_ID = 'building-a-learning-system';
export const ARTICLE_IDS = [ARTICLE_ID] as const;

export const ARTICLE_LOCALES = ['en', 'zh', 'bilingual'] as const;

export type ArticleLocale = (typeof ARTICLE_LOCALES)[number];

export const articleCopy = {
  en: {
    navHome: 'Home',
    navDocs: 'Chinese Docs',
    navArticles: 'English Articles',
    listEyebrow: 'Field notes for curious builders',
    listTitle: 'English Articles',
    listDescription:
      'Long-form notes on learning, software, and the systems that help ideas become useful.',
    readArticle: 'Read article',
    languageLabel: 'Article language',
    backToArticles: 'All articles',
    translationNote: 'Choose a reading language. Your choice is saved in the URL.',
  },
  zh: {
    navHome: '首页',
    navDocs: '中文文档',
    navArticles: '英文文章',
    listEyebrow: '写给好奇的构建者的思考笔记',
    listTitle: '英文文章',
    listDescription:
      '关于学习、软件，以及让想法变得有用的系统的长文笔记。',
    readArticle: '阅读文章',
    languageLabel: '文章语言',
    backToArticles: '全部文章',
    translationNote: '选择阅读语言，选择结果会保存在 URL 中。',
  },
  bilingual: {
    navHome: '首页 / Home',
    navDocs: '中文文档 / Chinese Docs',
    navArticles: '英文文章 / English Articles',
    listEyebrow: '中英对照 · Field notes for curious builders',
    listTitle: '英文文章 / English Articles',
    listDescription:
      '关于学习、软件，以及让想法变得有用的系统的长文笔记。\nLong-form notes on learning, software, and the systems that help ideas become useful.',
    readArticle: '阅读文章 / Read article',
    languageLabel: '文章语言 / Article language',
    backToArticles: '全部文章 / All articles',
    translationNote:
      '选择阅读语言，选择结果会保存在 URL 中。\nChoose a reading language. Your choice is saved in the URL.',
  },
} satisfies Record<ArticleLocale, Record<string, string>>;

export function getArticleLocale(
  value: string | string[] | undefined,
): ArticleLocale {
  const values = Array.isArray(value) ? value : [value];
  const locale = values.find((candidate) =>
    ARTICLE_LOCALES.includes(candidate as ArticleLocale),
  );

  return (locale as ArticleLocale | undefined) ?? 'en';
}

export function getArticleUrl(
  articleId: string,
  locale: ArticleLocale,
): string {
  return `/articles/${articleId}?lang=${locale}`;
}

export function getArticleListUrl(locale: ArticleLocale): string {
  return `/articles?lang=${locale}`;
}

export function getArticleSourceSlug(
  articleId: string,
  locale: ArticleLocale,
): string[] {
  return [articleId, locale];
}
