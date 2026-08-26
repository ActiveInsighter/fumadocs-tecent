import type { ReactNode } from 'react';

interface DocumentDownloadMenuProps {
  readonly documentId: string;
  readonly version: number;
}

export function DocumentDownloadMenu({
  documentId,
  version,
}: DocumentDownloadMenuProps): ReactNode {
  const basePath = `/download/${encodeURIComponent(documentId)}/${version}`;

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-fd-muted">
        Download
      </summary>
      <div className="absolute right-0 z-10 mt-2 grid min-w-36 gap-1 rounded-lg border bg-fd-background p-1 shadow-lg">
        <a
          className="rounded-md px-3 py-2 text-sm hover:bg-fd-muted"
          href={`${basePath}/md`}
          download
        >
          Markdown
        </a>
        <a
          className="rounded-md px-3 py-2 text-sm hover:bg-fd-muted"
          href={`${basePath}/pdf`}
          download
        >
          PDF
        </a>
      </div>
    </details>
  );
}
