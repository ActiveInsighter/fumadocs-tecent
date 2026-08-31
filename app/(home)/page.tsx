import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="mb-3 text-sm font-medium text-fd-muted-foreground">
          马克思主义基本原理 · 毛中特 · 史纲 · 习近平新时代中国特色社会主义思想
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
          考研政治知识点
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-balance text-fd-muted-foreground">
          按课程与章节整理的系统讲义，帮助你从知识框架、核心概念到易混点逐步复习。
        </p>
        <Link
          href="/docs"
          className="mt-8 inline-flex h-10 items-center rounded-md bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground"
        >
          开始学习
        </Link>
      </div>
    </main>
  );
}
