import catalogue from '../../../../../../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json' with { type: 'json' };

export function GET(): Response {
  return Response.json(catalogue, {
    headers: {
      'Content-Disposition': 'attachment; filename="aiq-core-1.1.0-catalog.json"',
    },
  });
}
