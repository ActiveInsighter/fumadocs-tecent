import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="mb-3 text-sm font-medium text-fd-muted-foreground">
          Next.js 16 · Fumadocs · Vercel
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
          Fumadocs Vercel
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-balance text-fd-muted-foreground">
          文档在 GitHub Actions 中构建，并以预构建产物部署到 Vercel。
        </p>
        <Link
          href="/docs"
          className="mt-8 inline-flex h-10 items-center rounded-md bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground"
        >
          打开文档
        </Link>
      </div>
    </main>
  );
}
