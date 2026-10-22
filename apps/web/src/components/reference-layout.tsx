import type { ReactNode } from 'react';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr/DownloadSimple';
import { SectionLink } from './section-link.tsx';

export function ReferenceHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="reference-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}

export function ReferenceNavigation({
  sections,
}: {
  sections: readonly (readonly [string, string])[];
}) {
  return (
    <nav className="reference-index" aria-label="On this page">
      {sections.map(([id, label]) => (
        <SectionLink key={id} targetId={`${id}-heading`} href={`#${id}`}>
          {label}
        </SectionLink>
      ))}
    </nav>
  );
}

export function ReferenceSection({
  id,
  title,
  children,
  wide = false,
  label,
}: {
  id: string;
  title: string;
  children: ReactNode;
  wide?: boolean;
  label?: string;
}) {
  return (
    <section
      id={id}
      className={`reference-section${wide ? ' reference-section-wide' : ''}`}
      aria-label={label}
    >
      <h3 id={`${id}-heading`} tabIndex={-1}>
        {title}
      </h3>
      <div className="reference-section-body">{children}</div>
    </section>
  );
}

export function SourceDownload({
  href,
  label,
  children,
  detail,
  actionLabel = 'Download ↓',
}: {
  href: string;
  label: string;
  children: ReactNode;
  detail: string;
  actionLabel?: string;
}) {
  return (
    <a className="source-download" href={href} aria-label={label} download>
      <DownloadSimpleIcon size={18} aria-hidden="true" />
      <span>
        <span className="source-download-name">{children}</span>
        <span className="source-download-detail">{detail}</span>
      </span>
      <span className="source-download-action">{actionLabel}</span>
    </a>
  );
}
