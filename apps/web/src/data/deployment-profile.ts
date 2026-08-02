export type DeploymentProfile = 'standard' | 'preview' | 'invalid';

export interface DeploymentProfileInspection {
  readonly profile: DeploymentProfile;
  readonly issues: readonly string[];
}

export function inspectDeploymentProfile(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentProfileInspection {
  const rawProfile = environment.AIQ_DEPLOYMENT_PROFILE;
  if (rawProfile === undefined || rawProfile === '') {
    return { profile: 'standard', issues: [] };
  }
  if (rawProfile === 'preview') {
    return { profile: 'preview', issues: [] };
  }
  return {
    profile: 'invalid',
    issues: ['AIQ_DEPLOYMENT_PROFILE must be absent or exactly preview'],
  };
}
