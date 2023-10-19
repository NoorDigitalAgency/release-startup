export function wait(milliseconds: number) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function versioning(stage: string, reference: string, hotfix: boolean, previousVersion: string | undefined, lastProductionVersion: string | undefined) {

  let version;

  const productionVersion = lastProductionVersion?.split('v').pop()?.split('.').reverse();

  const currentYear = (new Date()).getFullYear().toString();

  if (productionVersion instanceof Array && productionVersion.length >= 2) {

    const productionYear = productionVersion.pop();

    const spike = productionYear !== currentYear;

    const year = hotfix ? productionYear : currentYear;

    let revision = +(productionVersion.pop() as string);

    revision = hotfix ? revision : spike ? 1 : revision + 1;

    const fix = hotfix ? `.${+(productionVersion.pop() ?? '0') + 1}` : '';

    version = `v${year}.${revision}${fix}`;

  } else {

    version = `v${currentYear}.1`;
  }

  const prerelease = !hotfix && stage !== 'production';

  if (prerelease) {

    if (stage === 'beta') {

      const alphaVersion = reference === '' ? previousVersion : reference;

      if (!alphaVersion || !/^v20\d{2}\.\d{1,3}-alpha.\d{1,4}$/.test(alphaVersion)) {

        throw new Error(!alphaVersion ?

          `No previous 'alpha' release was found to be used as the base for the 'beta' release.` :

          `The previous 'alpha' release ${alphaVersion} doesn't have a correct version tag and cannot be used as the base for a 'beta' release.'`);
      }

      version = alphaVersion.split('alpha').join('beta');

    } else {

      const alphaVersion = previousVersion?.split('v').pop()?.split('.').reverse();

      const alphaYear = alphaVersion?.pop();

      const alphaRevision = alphaVersion?.pop()?.split('-alpha').reverse()?.pop();

      const alphaIteration = alphaVersion?.pop();

      const baseVersion = version.split('v').pop()?.split('.').reverse() as Array<string>;

      const baseYear = baseVersion.pop();

      const baseRevision = baseVersion.pop();

      version = `v${baseYear}.${baseRevision}` === `v${alphaYear ?? ''}.${alphaRevision ?? ''}` ?

                `v${alphaYear}.${alphaRevision}-alpha.${+(alphaIteration ?? '0') + 1}` : `v${baseYear}.${baseRevision}-alpha.1`;
    }
  }

  return version;
}

interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  preRelease: (string | number)[];
}

function parseVersion(version: string): VersionInfo {
  const matches = version.match(/^v(\d+)\.(\d+)(?:\.(\d+))?(?:-([\w.]+))?$/);
  if (!matches) {
    throw new Error(`Invalid version format: ${version}`);
  }

  const [, major, minor, patch, preRelease] = matches;

  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: patch ? parseInt(patch, 10) : 0,
    preRelease: preRelease ? preRelease.split('.').map(part => isNaN(Number(part)) ? part : Number(part)) : []
  };
}

export function compareVersions(a: string, b: string): number {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  if (versionA.major !== versionB.major) {
    return versionB.major - versionA.major;
  }

  if (versionA.minor !== versionB.minor) {
    return versionB.minor - versionA.minor;
  }

  if (versionA.patch !== versionB.patch) {
    return versionB.patch - versionA.patch;
  }

  // Compare pre-release identifiers
  const preReleaseA = versionA.preRelease;
  const preReleaseB = versionB.preRelease;

  for (let i = 0; i < Math.min(preReleaseA.length, preReleaseB.length); i++) {
    if (preReleaseA[i] < preReleaseB[i]) {
      return 1;
    } else if (preReleaseA[i] > preReleaseB[i]) {
      return -1;
    }
  }

  return preReleaseA.length - preReleaseB.length;
}