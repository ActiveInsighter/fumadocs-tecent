import './global.css';
import 'katex/dist/katex.css';
import './surface-overrides.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Newsreader, Outfit } from 'next/font/google';
import type { ReactNode } from 'react';

const outfit = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-outfit',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-newsreader',
});

export const metadata: Metadata = {
  title: {
    default: 'Fumadocs Vercel',
    template: '%s | Fumadocs Vercel',
  },
  description: 'A Next.js documentation site powered by Fumadocs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`${outfit.variable} ${newsreader.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
