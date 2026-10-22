import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { benchmarkBoards, findBenchmarkBoard } from '../../../benchmarks/boards.ts';
import { MemoryBoardContent } from '../../../benchmarks/memory-board.tsx';
import { createPageMetadata } from '../../site-metadata.ts';

export function generateStaticParams() {
  return benchmarkBoards.map((board) => ({ id: board.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const board = findBenchmarkBoard((await params).id);
  if (!board) notFound();
  return createPageMetadata({
    title: board.title,
    path: `/benchmarks/${board.id}`,
    description: board.description,
  });
}

export default async function BenchmarkBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const board = findBenchmarkBoard((await params).id);
  if (!board) notFound();
  await connection();
  let content;
  if (board.benchmark === 'core') {
    const { CoreBoardContent } = await import('../../../benchmarks/core-board.tsx');
    content = <CoreBoardContent searchParams={searchParams} />;
  } else if (board.benchmark === 'harness') {
    const { HarnessBoardContent } = await import('../../../benchmarks/harness-board.tsx');
    content = <HarnessBoardContent />;
  } else {
    content = <MemoryBoardContent board={board} />;
  }
  return <div className="research-shell benchmark-workspace">{content}</div>;
}
