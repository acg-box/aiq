'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { benchmarkBoards, boardForPath, type BenchmarkBoard } from '../benchmarks/boards.ts';
import { NavigationPending } from './navigation-pending.tsx';
import { fitNavigationItems } from './navigation-overflow.ts';
import { ThemeControl, useColorTheme } from './theme-control.tsx';

function BoardLinks({
  boards,
  label = 'Main navigation',
  onNavigate,
}: {
  boards: readonly BenchmarkBoard[];
  label?: string;
  onNavigate?: (destination: string) => void;
}) {
  const pathname = usePathname();
  const currentBoard = boardForPath(pathname);
  return (
    <nav aria-label={label} className="workspace-boards">
      {boards.map((board) => (
        <Link
          key={board.id}
          href={`/benchmarks/${board.id}`}
          aria-label={board.title}
          aria-current={currentBoard?.id === board.id ? 'page' : undefined}
          onClick={() => onNavigate?.(`/benchmarks/${board.id}`)}
        >
          {board.title}
          <NavigationPending />
        </Link>
      ))}
    </nav>
  );
}

function WorkspaceLinks({ onNavigate }: { onNavigate?: (destination: string) => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace information" className="workspace-links">
      <Link
        href="/about"
        aria-current={pathname === '/about' ? 'page' : undefined}
        aria-label="About & definitions"
        onClick={() => onNavigate?.('/about')}
      >
        About
      </Link>
      <a href="https://github.com/acg-box/aiq">GitHub ↗</a>
      {onNavigate ? (
        <Link
          href="/"
          aria-current={pathname === '/' ? 'page' : undefined}
          onClick={() => onNavigate?.('/')}
        >
          Overview
        </Link>
      ) : null}
    </nav>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const theme = useColorTheme();
  const currentBoard = boardForPath(pathname);
  const navigation = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ visible: readonly string[]; requireMenu: boolean }>({
    visible: currentBoard ? [currentBoard.id] : [],
    requireMenu: false,
  });
  const visibleBoards = benchmarkBoards.filter(
    (board) =>
      board.id === currentBoard?.id || (!layout.requireMenu && layout.visible.includes(board.id)),
  );
  const hiddenBoards = benchmarkBoards.filter((board) => !visibleBoards.includes(board));
  const showMenu = hiddenBoards.length > 0 || layout.requireMenu;
  const menu = useRef<HTMLDialogElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => {
    const current = menu.current;
    if (!current?.open) return;
    current.close();
    current.inert = true;
    current.setAttribute('aria-hidden', 'true');
    setOpen(false);
    const focusTarget = menuTrigger.current?.offsetWidth
      ? menuTrigger.current
      : (navigation.current?.querySelector<HTMLElement>('a[aria-current="page"]') ??
        navigation.current?.querySelector<HTMLElement>('a'));
    focusTarget?.focus({ preventScroll: true });
  }, []);
  const positionMenu = useCallback(() => {
    if (!menu.current?.open || !menuTrigger.current) return;
    const trigger = menuTrigger.current.getBoundingClientRect();
    const top =
      (menuTrigger.current.closest('header')?.getBoundingClientRect().bottom ?? trigger.bottom) + 8;
    menu.current.style.setProperty('--workspace-menu-top', `${top}px`);
    menu.current.style.left = `${Math.max(16, Math.min(trigger.left, innerWidth - menu.current.offsetWidth - 16))}px`;
  }, []);
  useLayoutEffect(() => {
    const container = navigation.current;
    const ruler = measurements.current;
    const more = ruler?.lastElementChild;
    if (!container || !ruler || !more) return undefined;
    const measure = () => {
      const headerHeight = container.closest('header')?.getBoundingClientRect().height;
      if (headerHeight)
        document.documentElement.style.setProperty(
          '--workspace-header-height',
          `${headerHeight}px`,
        );
      const style = getComputedStyle(container);
      const requireMenu = style.getPropertyValue('--workspace-menu-required').trim() === '1';
      const sizes = [...ruler.children].map((item) => item.getBoundingClientRect().width);
      const visibleIndices = requireMenu
        ? []
        : fitNavigationItems(
            sizes.slice(0, -1),
            benchmarkBoards.findIndex((board) => board.id === currentBoard?.id),
            container.clientWidth,
            more.getBoundingClientRect().width,
            parseFloat(style.columnGap),
            false,
          );
      const visible = benchmarkBoards
        .filter((_, index) => visibleIndices.includes(index))
        .map((board) => board.id);
      setLayout((previous) =>
        previous.requireMenu === requireMenu && previous.visible.join() === visible.join()
          ? previous
          : { visible, requireMenu },
      );
      positionMenu();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const item of ruler.children) observer.observe(item);
    measure();
    return () => observer.disconnect();
  }, [currentBoard?.id, positionMenu]);
  useEffect(() => {
    closeMenu();
  }, [pathname, closeMenu]);
  useEffect(() => {
    if (!showMenu) closeMenu();
  }, [showMenu, closeMenu]);
  return (
    <>
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <Link className="research-brand" href="/" aria-label="AIQ home">
            AIQ <span className="workspace-home-label">Overview</span>
          </Link>
          <div className="workspace-desktop-navigation" ref={navigation}>
            <BoardLinks boards={visibleBoards} />
            <button
              ref={menuTrigger}
              type="button"
              aria-label="Open benchmark navigation"
              aria-expanded={open}
              aria-controls="benchmark-menu"
              className="ui-action workspace-menu-trigger"
              hidden={!showMenu}
              onClick={() => {
                const current = menu.current;
                if (!current) return;
                current.inert = false;
                current.setAttribute('aria-hidden', 'false');
                current.showModal();
                positionMenu();
                setOpen(true);
              }}
            >
              More <CaretDownIcon size={13} aria-hidden="true" />
            </button>
            <div
              className="workspace-navigation-measure"
              ref={measurements}
              aria-hidden="true"
              inert
            >
              {benchmarkBoards.map((board) => (
                <span className="workspace-board-measure" key={board.id}>
                  {board.title}
                </span>
              ))}
              <span className="ui-action workspace-menu-trigger">
                More <CaretDownIcon size={13} aria-hidden="true" />
              </span>
            </div>
          </div>
          <div className="workspace-header-actions">
            <div className="workspace-desktop-information">
              <WorkspaceLinks />
            </div>
            {!layout.requireMenu ? (
              <div className="workspace-theme">
                <ThemeControl theme={theme} />
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <dialog
        id="benchmark-menu"
        className="workspace-mobile-menu"
        ref={menu}
        inert
        aria-hidden="true"
        onCancel={(event) => {
          event.preventDefault();
          closeMenu();
        }}
        aria-label="Benchmark navigation"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            closeMenu();
        }}
      >
        <div className="mobile-menu-heading">
          <span>{hiddenBoards.length > 0 ? 'Switch benchmark' : 'Workspace'}</span>
          <button
            className="ui-action ui-icon-action"
            type="button"
            onClick={closeMenu}
            aria-label="Close benchmark navigation"
          >
            <XIcon size={18} aria-hidden="true" />
          </button>
        </div>
        {hiddenBoards.length > 0 ? (
          <BoardLinks
            boards={hiddenBoards}
            label="More benchmarks"
            onNavigate={(destination) => {
              if (destination === pathname) closeMenu();
            }}
          />
        ) : null}
        <div className="workspace-menu-utilities" role="group" aria-label="Workspace utilities">
          <div className="workspace-theme workspace-menu-theme">
            <span>Theme</span>
            <ThemeControl theme={theme} textLabels />
          </div>
          <WorkspaceLinks
            onNavigate={(destination) => {
              if (destination === pathname) closeMenu();
            }}
          />
        </div>
      </dialog>
    </>
  );
}
