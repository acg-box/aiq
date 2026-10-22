import { harnessPlan } from '../../../../../benchmarks/harness-plan.ts';

export function GET(): Response {
  return Response.json(harnessPlan, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="harness-rank-protocol-${harnessPlan.protocol_version}.json"`,
    },
  });
}
