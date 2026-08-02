// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createReadinessHandler } from '../../../server/readiness.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = createReadinessHandler();
