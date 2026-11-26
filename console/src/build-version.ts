// The version a build bakes into the page (read by console/vite.config.ts). The packer hands
// the release's version over in the environment; any other build is of the checkout, whose
// package.json says major.minor only, and is said to be a development build.
import { RELEASE_VERSION_ENV, versionText } from '../../shared/version.ts';

export function bakedVersion(env: Record<string, string | undefined>, packageVersion: string): string {
  const release = env[RELEASE_VERSION_ENV];
  return release ? versionText(release, true) : versionText(packageVersion, false);
}
