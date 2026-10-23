import { test } from '@playwright/test';
import { expectUnavailableCore } from '../browser-tests/configuration-assertions.ts';

test('partial public Supabase configuration fails closed without synthetic measurements', async ({
  page,
}) => {
  await expectUnavailableCore(page);
});
