import './global.css';
import 'katex/dist/katex.css';
import './surface-overrides.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import type { ReactNode } from 'react';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-source-serif',
});

export const metadata: Metadata = {
  title: {
    default: '考研政治知识点',
    template: '%s | 考研政治知识点',
  },
  description: '面向考研复习的政治知识点系统讲义，按课程和章节整理。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`${inter.variable} ${sourceSerif4.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col font-sans" suppressHydrationWarning>
        <RootProvider
          search={{
            options: {
              // 静态搜索：/api/search 现在导出构建期生成的索引 JSON，
              // 客户端下载后本地查询，运行时不再需要按查询调用函数。
              type: 'static',
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
