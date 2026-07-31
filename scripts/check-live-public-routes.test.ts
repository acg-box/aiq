import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const livePublicRoutes = [
  'apps/web/src/app/page.tsx',
  'apps/web/src/app/compare/page.tsx',
  'apps/web/src/app/trends/page.tsx',
  'apps/web/src/app/method/page.tsx',
  'apps/web/src/app/radar/page.tsx',
  'apps/web/src/app/runs/page.tsx',
  'apps/web/src/app/runs/[id]/page.tsx',
] as const;

const serverApiRoutes = [
  'apps/web/src/app/api/submissions/route.ts',
  'apps/web/src/app/api/artifacts/route.ts',
  'apps/web/src/app/api/artifacts/resolve/route.ts',
  'apps/web/src/app/api/claims/route.ts',
  'apps/web/src/app/api/verifications/route.ts',
  'apps/web/src/app/api/readiness/route.ts',
] as const;

void describe('live public route rendering', () => {
  for (const route of livePublicRoutes) {
    void it(`${route} reads current Supabase state per request`, () => {
      const source = readFileSync(join(repositoryRoot, route), 'utf8');

      assert.match(
        source,
        /export const dynamic = ['"]force-dynamic['"];/,
        'A build-time snapshot would freeze twice-daily benchmark updates until redeployment.',
      );
    });
  }
});

void describe('controlled API route runtime', () => {
  for (const route of serverApiRoutes) {
    void it(`${route} stays dynamic on the Node.js runtime`, () => {
      const source = readFileSync(join(repositoryRoot, route), 'utf8');

      assert.match(source, /export const dynamic = ['"]force-dynamic['"];/);
      assert.match(source, /export const runtime = ['"]nodejs['"];/);
    });
  }
});
