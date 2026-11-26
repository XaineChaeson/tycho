// How a version of tycho is said to the owner. A release is a program loaded from where an
// installer put it (<prefix>/versions/<version>) or a console page the packer built; any
// other copy runs from a checkout or from files put somewhere by hand, and says so. The
// number alone does not tell: a checkout may carry any version.
export const versionText = (version: string, released: boolean): string => (released ? version : `${version} 开发版`);

// How scripts/pack.ts hands the release's version to the console build.
export const RELEASE_VERSION_ENV = 'TYCHO_RELEASE_VERSION';
