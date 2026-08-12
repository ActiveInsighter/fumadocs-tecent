import { articles } from 'collections/server';
import { loader } from 'fumadocs-core/source';

export const articleSource = loader({
  baseUrl: '/articles',
  source: articles.toFumadocsSource(),
});
