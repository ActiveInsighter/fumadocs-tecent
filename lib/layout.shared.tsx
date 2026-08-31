import type {
  BaseLayoutProps,
  LinkItemType,
} from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: '考研政治知识点',
    },
    githubUrl: 'https://github.com/ActiveInsighter/fumadocs-tecent',
  };
}

export const linkItems: LinkItemType[] = [
  {
    type: 'main',
    text: '知识点',
    url: '/docs',
  },
  {
    type: 'main',
    text: 'Blog',
    url: '/blog',
  },
];
