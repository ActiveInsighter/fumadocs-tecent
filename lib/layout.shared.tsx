import type {
  BaseLayoutProps,
  LinkItemType,
} from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Fumadocs Vercel',
    },
    githubUrl: 'https://github.com/ActiveInsighter/fumadocs-vercel',
  };
}

export const linkItems: LinkItemType[] = [
  {
    type: 'main',
    text: 'Documentation',
    url: '/docs',
  },
  {
    type: 'main',
    text: 'Blog',
    url: '/blog',
  },
];
