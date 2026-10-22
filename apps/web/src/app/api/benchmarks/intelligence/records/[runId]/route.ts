import { createAiqRepository, SupabaseAiqRepository } from '../../../../../../data/repository.ts';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^run_[a-f0-9]{64}(?![\s\S])/.test(runId)) return new Response('Not found', { status: 404 });
  const repository = createAiqRepository();
  if (!(repository instanceof SupabaseAiqRepository))
    return new Response('Archive unavailable', { status: 503 });
  try {
    const rows = await repository.listHistoricalCoreResults(await repository.listLeaderboard());
    const row = rows.find(({ run }) => run.id === runId);
    if (!row) return new Response('Not found', { status: 404 });
    return Response.json(
      {
        source: 'Supabase public_leaderboard and public_runs',
        observedAt: new Date().toISOString(),
        historical: true,
        currentCoreOfficialEligible: false,
        benchmarkVersion: row.run.benchmarkVersion,
        leaderboard: row.entry,
        publicRunRecord: row.source,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return new Response('Archive unavailable', { status: 503 });
  }
}
