'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const DEFAULT_MODULE_URL = '/docs/politics';

export default function DocsEntryPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(DEFAULT_MODULE_URL);
  }, [router]);

  return (
    <main className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-6">
      <div className="text-center">
        <p className="text-sm text-fd-muted-foreground">正在进入学习模块…</p>
        <Link
          href={DEFAULT_MODULE_URL}
          className="mt-4 inline-block border-b border-current text-sm font-medium"
        >
          如果没有自动跳转，点击这里继续
        </Link>
      </div>
    </main>
  );
}
