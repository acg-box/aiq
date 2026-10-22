import type { ReactNode } from 'react';

export function TableNotes({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="table-annotation">
      {hint ? <p className="table-hint">{hint}</p> : null}
      <details className="table-notes" aria-label={`${label} notes`}>
        <summary lang="zh-CN">说明</summary>
        <div className="table-notes-content">{children}</div>
      </details>
    </div>
  );
}
