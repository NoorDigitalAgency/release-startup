import {exec} from "node:child_process";
import type { GitHub } from '@actions/github/lib/utils';

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

export function shell(command: string, args: string[] = [], options = { shouldRejectOnError: false }): Promise<{stdout: string, stderr: string, exitCode: number}> {
  return new Promise((resolve, reject) => {
    const fullCommand = `${command} ${args.join(' ')}`;

    exec(fullCommand, (error, stdout, stderr) => {
      if (error && options.shouldRejectOnError) {
        reject(new Error(stderr));
      } else {
        resolve({
          exitCode: error ? error.code ?? 1 : 0,
          stdout,
          stderr
        });
      }
    });
  });
}

type Octokit = InstanceType<typeof GitHub>;

export interface CheckUnmergedPRsOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseBranch?: string;
}

export interface PullRequestSummary {
  title: string;
  url: string;
}

type OriginBranch = 'main' | 'release';

interface MergeBaseInfo {
  branch: string;
  sha: string;
  timestamp: number;
}

const ORIGIN_BRANCHES: OriginBranch[] = ['main', 'release'];
const mergeBaseCache = new Map<string, MergeBaseInfo | null>();

export async function checkUnmergedPRs(options: CheckUnmergedPRsOptions): Promise<PullRequestSummary[]> {
  const {
    octokit,
    owner,
    repo,
    baseBranch = 'develop'
  } = options;

  if (!octokit) {
    throw new Error('An authenticated Octokit client must be provided to check for unmerged PRs.');
  }

  const pullRequests = await octokit.paginate(
    octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: 'open',
      per_page: 100
    },
    response => response.data
  );

  const pending = [];

  for (const pr of pullRequests) {
    if (pr.base.ref !== baseBranch) {
      continue;
    }

    if (await isDerivedFromOriginBranch(octokit, owner, repo, pr.head.ref, baseBranch)) {
      pending.push({
        title: pr.title,
        url: pr.html_url
      });
    }
  }

  return pending;
}

async function isDerivedFromOriginBranch(octokit: Octokit, owner: string, repo: string, headRef: string, baseBranch: string): Promise<boolean> {
  if (ORIGIN_BRANCHES.some(origin => origin === headRef)) {
    return true;
  }

  const developMergeBase = await getMergeBaseInfo(octokit, owner, repo, baseBranch, headRef);
  const candidateInfo = (await Promise.all(
    ORIGIN_BRANCHES.map(origin => getMergeBaseInfo(octokit, owner, repo, origin, headRef))
  )).filter((info): info is MergeBaseInfo => Boolean(info));

  if (candidateInfo.length === 0) {
    return false;
  }

  candidateInfo.sort((a, b) => b.timestamp - a.timestamp);
  const bestCandidate = candidateInfo[0];

  if (!developMergeBase) {
    return true;
  }

  if (bestCandidate.timestamp > developMergeBase.timestamp) {
    return true;
  }

  return bestCandidate.timestamp === developMergeBase.timestamp && bestCandidate.sha !== developMergeBase.sha;
}

async function getMergeBaseInfo(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<MergeBaseInfo | null> {
  const cacheKey = `${base}->${head}`;

  if (mergeBaseCache.has(cacheKey)) {
    return mergeBaseCache.get(cacheKey) ?? null;
  }

  try {
    const comparison = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head
    });

    const commit = comparison.data.merge_base_commit;

    if (!commit) {
      mergeBaseCache.set(cacheKey, null);
      return null;
    }

    const timestamp = new Date(
      commit.commit?.committer?.date ??
      commit.commit?.author?.date ??
      0
    ).getTime();

    const info: MergeBaseInfo = {
      branch: base,
      sha: commit.sha,
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp
    };

    mergeBaseCache.set(cacheKey, info);

    return info;
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;

    if (status === 404) {
      mergeBaseCache.set(cacheKey, null);
      return null;
    }

    throw error;
  }
}
