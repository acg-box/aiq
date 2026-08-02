import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectDeploymentProfile } from './deployment-profile.ts';

void describe('deployment profile', () => {
  void it('uses the standard profile when the variable is absent', () => {
    assert.deepEqual(inspectDeploymentProfile({}), { profile: 'standard', issues: [] });
  });

  void it('accepts only the exact preview profile', () => {
    assert.deepEqual(inspectDeploymentProfile({ AIQ_DEPLOYMENT_PROFILE: 'preview' }), {
      profile: 'preview',
      issues: [],
    });
    for (const value of ['Preview', ' preview', 'preview ', 'production', 'standard']) {
      const result = inspectDeploymentProfile({ AIQ_DEPLOYMENT_PROFILE: value });
      assert.equal(result.profile, 'invalid');
      assert.ok(result.issues.length > 0);
    }
  });
});
