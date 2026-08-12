import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_LOCALES,
  getArticleLocale,
  getArticleUrl,
} from '../lib/articles.ts';

test('accepts the three supported article locales', () => {
  assert.deepEqual(ARTICLE_LOCALES, ['en', 'zh', 'bilingual']);
  assert.equal(getArticleLocale('en'), 'en');
  assert.equal(getArticleLocale('zh'), 'zh');
  assert.equal(getArticleLocale('bilingual'), 'bilingual');
});

test('falls back to English for an omitted or unsupported locale', () => {
  assert.equal(getArticleLocale(undefined), 'en');
  assert.equal(getArticleLocale(['zh', 'en']), 'zh');
  assert.equal(getArticleLocale('fr'), 'en');
});

test('creates a shareable URL for the selected article language', () => {
  assert.equal(
    getArticleUrl('building-a-learning-system', 'bilingual'),
    '/articles/building-a-learning-system?lang=bilingual',
  );
});
