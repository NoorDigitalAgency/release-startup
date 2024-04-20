import exp from "node:constants";
import {exec, ExecOptions} from "@actions/exec";
import {$} from "zx";

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

function simplifyVersion(version: string): number {
  const matches = version.match(/^v(\d+)\.(\d+)(?:\.(\d+))?(?:-([\w.]+))?$/);
  if (!matches) {
    throw new Error(`Invalid version format: ${version}`);
  }

  const [, major, minor, patch, pre] = matches;

  const info = {
    major: parseInt(major),
    minor: 100 + parseInt(minor),
    patch: 100 + (patch ? parseInt(patch) : 0),
    preRelease: pre ? pre.split('.').map(part => isNaN(Number(part)) ? part === 'alpha' ? 1000 : part === 'beta' ? 4000 : 0 : Number(part)).reduce((p, c) => p + c) : 8000
  };

  return +`${info.major}${info.minor}${info.patch}${info.preRelease}`;
}

export function compareVersions(a: string, b: string): number {

  return simplifyVersion(b) - simplifyVersion(a);
}

export function execute(command: string, args: string[] = []) {

  return $`${command} ${args.join(' ')}`;
}