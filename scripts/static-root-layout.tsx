import './global.css';
import 'katex/dist/katex.css';
import './surface-overrides.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';

export const metadata: Metadata = {
  title: {
    default: '考研政治知识点',
    template: '%s | 考研政治知识点',
  },
  description: '面向考研复习的政治知识点系统讲义，按课程和章节整理。',
};

const fontVariables = {
  '--font-inter': "'Inter', 'Arial'",
  '--font-source-serif': "'Source Serif 4', Georgia",
  '--font-outfit': "'Inter', 'Arial'",
} as CSSProperties;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" style={fontVariables} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans" suppressHydrationWarning>
        <RootProvider
          search={{
            options: {
              // 静态搜索：客户端从 /api/search 下载构建期导出的索引并在本地查询。
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
