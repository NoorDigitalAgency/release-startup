import {exec, type ExecException} from "node:child_process";
import type { GitHub } from '@actions/github/lib/utils';
import {summary, info, debug, warning, startGroup, endGroup} from "@actions/core";
import { inspect as stringify } from 'util';
import { DefaultArtifactClient } from "@actions/artifact";
import { rmRF } from "@actions/io";
import { writeFileSync, existsSync } from "node:fs";

export function wait(milliseconds: number) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function versioning(
  stage: string,
  reference: string,
  hotfix: boolean,
  previousVersion: string | undefined,
  lastProductionVersion: string | undefined,
  latestStageVersion?: string | undefined
) {

  if (hotfix && stage === 'beta') {

    const betaVersion = latestStageVersion;

    if (!betaVersion || !/^v20\d{2}\.\d{1,3}(?:\.\d{1,3})?-beta\.\d{1,4}(?:\.\d{1,4})?$/.test(betaVersion)) {

      throw new Error(
        betaVersion ?
          `The last 'beta' release '${betaVersion}' does not match the expected format for hotfixing.` :
          `No previous 'beta' release was found to be used as the base for the 'beta' hotfix.`
      );
    }

    const match = betaVersion.match(/^v(20\d{2})\.(\d{1,3})(?:\.(\d{1,3}))?-beta\.(\d{1,4})(?:\.(\d{1,4}))?$/);

    if (!match) {

      throw new Error(`Unable to parse the previous 'beta' version '${betaVersion}' for hotfixing.`);
    }

    const [, betaYear, betaRevision, betaPatch, betaIteration, betaFix] = match;

    const nextFix = +(betaFix ?? '0') + 1;

    const patchSegment = betaPatch ? `.${betaPatch}` : '';

    return `v${betaYear}.${betaRevision}${patchSegment}-beta.${betaIteration}.${nextFix}`;
  }

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

export function buildExtendedVersion(version: string): string {

  const match = version.match(/^(v20\d{2}\.\d{1,3})(\.\d{1,3})?(.*)$/);

  if (!match) {

    return version;
  }

  const [, majorMinor, patch, suffix] = match;

  return `${majorMinor}${patch ?? '.0'}${suffix}`;
}

export const UNMERGED_PR_FLAG_ARTIFACT = 'release-startup-unmerged-pr-flag';
const UNMERGED_PR_FLAG_FILE = '.release-startup-unmerged-pr-flag';

type StageBranch = "develop" | "release" | "main";
type ReleaseStage = "alpha" | "beta";

interface AssertOpenPROptions {
  baseBranch: StageBranch;
  forbiddenBranches: StageBranch[];
  summaryTitle: string;
  errorMessage: (count: number) => string;
}

const DEFAULT_ASSERT_OPEN_PR_OPTIONS: AssertOpenPROptions = {
  baseBranch: "develop",
  forbiddenBranches: ["main", "release"],
  summaryTitle: "Open Hotfix PRs Detected:",
  errorMessage: (count: number) => `Detected ${count} open hotfix PR(s) into develop based on main or release.`,
};

const STAGE_OPEN_PR_CHECKS: Record<ReleaseStage, AssertOpenPROptions[]> = {
  alpha: [
    { ...DEFAULT_ASSERT_OPEN_PR_OPTIONS },
    {
      baseBranch: "release",
      forbiddenBranches: ["main"],
      summaryTitle: "Open main->release PRs Detected:",
      errorMessage: (count: number) => `Detected ${count} open PR(s) into release based on main. Merge them before starting an alpha release.`,
    },
  ],
  beta: [
    {
      baseBranch: "release",
      forbiddenBranches: ["main"],
      summaryTitle: "Open main->release PRs Detected:",
      errorMessage: (count: number) => `Detected ${count} open PR(s) into release based on main. Merge them before starting a beta release.`,
    },
  ],
};

export async function ensureFreshWorkflowRun(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  runId: number,
  stage?: string,
  gitRemoteUrl?: URL
): Promise<void> {
  const normalizedStage = stage?.trim().toLowerCase() as ReleaseStage | undefined;

  const artifacts = await octokit.paginate(
    octokit.rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: runId, per_page: 100 },
    response => response.data.artifacts
  );

  let hasFlag = artifacts.some(artifact => (artifact?.name ?? '') === UNMERGED_PR_FLAG_ARTIFACT);

  if (!hasFlag) {
    debug(`No flag artifact found on current attempt for run ${runId}. Checking repository artifacts for prior attempts.`);
    for await (const response of octokit.paginate.iterator(
      octokit.rest.actions.listArtifactsForRepo,
      { owner, repo, per_page: 100 }
    )) {
      const repoArtifacts = response.data ?? [];
      hasFlag = repoArtifacts.some(artifact =>
        (artifact?.name ?? '') === UNMERGED_PR_FLAG_ARTIFACT &&
        artifact.workflow_run?.id === runId
      );
      if (hasFlag) {
        debug(`Flag artifact detected in repository artifacts for run ${runId}.`);
        break;
      }
    }
  }

  if (hasFlag) {
    const stageLabel = normalizedStage ? `${normalizedStage[0].toUpperCase()}${normalizedStage.slice(1)}` : "Alpha";
    throw new Error(`⚠️ Do not re-run this ${stageLabel.toLowerCase()} release workflow run. ✅️ When the PRs are merged, start a brand-new ${stageLabel} Release to prevent un-syncing the branches.`);
  }

  if (normalizedStage && STAGE_OPEN_PR_CHECKS[normalizedStage]) {
    await ensureRepositoryForStageChecks(normalizedStage, gitRemoteUrl);
    await enforceStageOpenPrChecks(octokit, owner, repo, normalizedStage);
  }
}

async function ensureRepositoryForStageChecks(stage: ReleaseStage, gitRemoteUrl?: URL): Promise<void> {
  if (existsSync(".git")) {
    return;
  }
  if (!gitRemoteUrl) {
    throw new Error("Unable to run stage safeguards: repository checkout is missing and no git URL was provided.");
  }
  const bootstrapBranch: StageBranch = stage === "beta" ? "release" : "develop";
  await prepareRepository(gitRemoteUrl, bootstrapBranch);
}

async function enforceStageOpenPrChecks(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  stage: ReleaseStage
): Promise<void> {
  for (const checkOptions of STAGE_OPEN_PR_CHECKS[stage]) {
    try {
      await assertOpenPRs(octokit, owner, repo, false, checkOptions);
    } catch (error) {
      if (error instanceof BlockingHotfixPRError) {
        await handleBlockingHotfixPre(stage);
      }
      throw error;
    }
  }
}

async function handleBlockingHotfixPre(stage: ReleaseStage): Promise<void> {
  try {
    await uploadUnmergedPrFlagArtifact();
  } catch (artifactError) {
    const stageLabel = stage === "alpha" ? "Alpha" : "Beta";
    const issueLabel = stage === "alpha" ? "hotfix PR(s)" : "blocking PR(s)";
    warning(`⚠️ DO NOT RE-RUN THIS FAILED STEPS, otherwise, the release branch will fall behind. ⚠️ ✅️ RUN A FRESH RUN of the ${stageLabel} Release workflow after merging the ${issueLabel}. ✅️`);
    startGroup('Flag Artifact Upload Error');
    debug(`${stringify(artifactError, { depth: 5 })}`);
    endGroup();
  }
}

export async function uploadUnmergedPrFlagArtifact(): Promise<void> {
  const client = new DefaultArtifactClient();
  const payload = JSON.stringify({ reason: "unmerged_prs", createdAt: new Date().toISOString() }, null, 2);
  writeFileSync(UNMERGED_PR_FLAG_FILE, payload);
  try {
    await client.uploadArtifact(UNMERGED_PR_FLAG_ARTIFACT, [UNMERGED_PR_FLAG_FILE], '.', { retentionDays: 1 });
  } finally {
    try {
      await rmRF(UNMERGED_PR_FLAG_FILE);
    } catch (error) {
      warning('Unable to delete the unmerged PR flag artifact file.');
      startGroup('Flag Artifact Cleanup Error');
      debug(`${stringify(error, { depth: 5 })}`);
      endGroup();
    }
  }
}

export class BlockingHotfixPRError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockingHotfixPRError";
  }
}

export function shell(command: string, args: string[] = [], options: { shouldRejectOnError?: boolean } = { shouldRejectOnError: false }): Promise<{stdout: string, stderr: string, exitCode: number}> {
  return new Promise((resolve, reject) => {
    const fullCommand = `${command} ${args.join(' ')}`;

    exec(fullCommand, (error: ExecException | null, stdout: string, stderr: string) => {
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

/**
 * Helper: count commits since the fork point between origin/<base> and <headLocalRef>.
 * Smaller is "closer". Infinity means we could not find a usable fork point.
 */
async function forkDist(base: string, headLocalRef: string): Promise<number> {
  const fp = await forkPoint(base, headLocalRef);
  if (!fp) return Number.POSITIVE_INFINITY;

  debug(`Counting commits since fork point: ${fp}..${headLocalRef}`);
  const cnt = await shell("git", ["rev-list", "--count", `${fp}..${headLocalRef}`]);
  debug(`Commit count: ${cnt.stdout.trim()}`);
  const n = parseInt(cnt.stdout.trim(), 10);
  debug(`Commit count: ${n}`);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Helper: given a PR head commit fetched to <localHeadRef>, decide which of the
 * candidate bases it is "closest to" by fork-point distance. Ties prefer the
 * earlier item in preferenceOrder, which lets you bias decisions.
 */
function chooseBestBase<T extends string>(distances: Record<T, number>, preferenceOrder: T[]): T {
  let bestBase = preferenceOrder[0];
  let bestDist = distances[bestBase];
  for (let i = 1; i < preferenceOrder.length; i++) {
    const b = preferenceOrder[i];
    const d = distances[b];
    if (
      (bestDist === Number.POSITIVE_INFINITY && d !== Number.POSITIVE_INFINITY) ||
      (d !== Number.POSITIVE_INFINITY && bestDist !== Number.POSITIVE_INFINITY && d < bestDist)
    ) {
      bestBase = b;
      bestDist = d;
    }
  }
  return bestBase;
}

async function forkPoint(base: string, headLocalRef: string): Promise<string | null> {
  debug(`Computing fork distance between 'origin/${base}' and '${headLocalRef}'.`);
  const fpTry = await shell("git", ["merge-base", "--fork-point", `origin/${base}`, headLocalRef]);
  debug(`Fork distance try: ${fpTry.stdout.trim()}`);
  let fp = fpTry.stdout.trim();
  debug(`Fork point: ${fp}`);
  if (!fp) {
    const fpFallback = await shell("git", ["merge-base", `origin/${base}`, headLocalRef]);
    debug(`Fork distance fallback: ${fpFallback.stdout.trim()}`);
    fp = fpFallback.stdout.trim();
    debug(`Fork point (fallback): ${fp}`);
  }
  return fp || null;
}

/**
 * Scans OPEN PRs targeting a branch and flags any whose head branch appears to be based on disallowed branches.
 * On failure, it writes a summary headed by `summaryTitle` listing the offending PRs, then throws an Error.
 */
export async function assertOpenPRs(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  includeDrafts = false,
  options: Partial<AssertOpenPROptions> = {}
): Promise<void> {
  const { baseBranch, forbiddenBranches, summaryTitle, errorMessage } = {
    ...DEFAULT_ASSERT_OPEN_PR_OPTIONS,
    ...options,
    forbiddenBranches: options.forbiddenBranches ?? DEFAULT_ASSERT_OPEN_PR_OPTIONS.forbiddenBranches,
  };

  const normalizedForbidden = Array.from(new Set(forbiddenBranches.filter(branch => branch !== baseBranch)));
  if (normalizedForbidden.length === 0) {
    return;
  }

  // Ensure up-to-date refs
  await shell("git", ["fetch", "origin", "--prune", "--quiet"], { shouldRejectOnError: true });

  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    base: baseBranch,
    per_page: 100,
  });

  const candidates = includeDrafts ? prs : prs.filter(p => !p.draft);
  if (candidates.length === 0) {
    return; // nothing to report and no failure
  }

  const offenders: { title: string; url: string }[] = [];

  const branchesToMeasure = Array.from(new Set<StageBranch>([baseBranch, ...normalizedForbidden]));

  for (const pr of candidates) {
    const prNumber = pr.number;
    const localHead = `refs/remotes/origin/pr-${prNumber}`;
    await shell("git", ["fetch", "origin", `+pull/${prNumber}/head:${localHead}`, "--quiet"], { shouldRejectOnError: true });

    const distances: Record<StageBranch, number> = {
      develop: Number.POSITIVE_INFINITY,
      main: Number.POSITIVE_INFINITY,
      release: Number.POSITIVE_INFINITY,
    };

    for (const branch of branchesToMeasure) {
      distances[branch] = await forkDist(branch, localHead);
    }

    const preference: StageBranch[] = [baseBranch, ...normalizedForbidden];
    const best = chooseBestBase(distances, preference);

    if (best !== baseBranch && normalizedForbidden.includes(best) && distances[best] !== Number.POSITIVE_INFINITY) {
      offenders.push({ title: pr.title ?? "(no title)", url: pr.html_url });
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map(o => `- [${o.title}](${o.url})`).join("\n");
    await summary
      .addRaw(summaryTitle, true)
      .addRaw(list, true)
      .write();

    throw new BlockingHotfixPRError(errorMessage(offenders.length));
  }
}

/**
 * Verifies that a given branch was actually branched from the intended stage branch ("main" or "release"),
 * and not from any other branch. Ties count as failure. On failure, it adds an explanatory summary and throws.
 */
export async function assertCorrectHotfixBranch(branch: string, stageBranch: "main" | "release"): Promise<void> {
  
  debug(`Checking hotfix branch '${branch}' is based on '${stageBranch}'.`);
  
  // Ensure up-to-date refs
  await shell("git", ["fetch", "origin", "--prune"], { shouldRejectOnError: true });
  
  debug(`Fetched refs.`);

  // Make sure we have the branch locally
  const localRef = `refs/remotes/origin/${branch}`;
  await shell("git", ["fetch", "origin", `+${branch}:${localRef}`], { shouldRejectOnError: true });

  debug(`Fetched branch '${branch}'.`);

  // Compute distances to the three canonical branches
  const dDevelop = await forkDist("develop", localRef);
  const dMain = await forkDist("main", localRef);
  const dRelease = await forkDist("release", localRef);

  debug(`Distances: ${stringify({ develop: dDevelop, main: dMain, release: dRelease })}`);

  const distances: Record<StageBranch, number> = { develop: dDevelop, main: dMain, release: dRelease };

  debug(`Distances: ${stringify(distances)}`);

  // We require the stageBranch to be strictly closest. Ties are failure.
  // Preference: put the expected stage FIRST so <= will prefer a competing base later in the list,
  // which causes the assertion to FAIL on ties (conservative).
  const preference: StageBranch[] = stageBranch === "main"
    ? ["main", "release", "develop"]
    : ["release", "main", "develop"];

  debug(`Preference: ${stringify(preference)}`);

  const detected = chooseBestBase(distances, preference);

  debug(`Detected: ${detected}`);

  const branchTips: Record<StageBranch, string | null> = {
    develop: null,
    main: null,
    release: null
  };

  for (const key of Object.keys(branchTips) as Array<keyof typeof branchTips>) {
    try {
      branchTips[key] = (await shell("git", ["rev-parse", `origin/${key}`], { shouldRejectOnError: true })).stdout.trim();
    } catch {
      branchTips[key] = null;
    }
  }

  const forkPoints: Record<StageBranch, string | null> = {
    develop: await forkPoint("develop", localRef),
    main: await forkPoint("main", localRef),
    release: await forkPoint("release", localRef)
  };

  const shareTip = (a: keyof typeof branchTips, b: keyof typeof branchTips): boolean => {
    return Boolean(branchTips[a] && branchTips[b] && branchTips[a] === branchTips[b]);
  };

  const normalizedDistances = Object.fromEntries(
    Object.entries(distances).map(([b, d]) => {
      if (b !== stageBranch && shareTip(b as keyof typeof branchTips, stageBranch)) {
        return [b, Number.POSITIVE_INFINITY];
      }
      return [b, d];
    })
  ) as typeof distances;

  const expectedDist = normalizedDistances[stageBranch];
  const competingBranches = Object.entries(normalizedDistances)
    .filter(([b, d]) =>
      b !== stageBranch &&
      d !== Number.POSITIVE_INFINITY &&
      expectedDist !== Number.POSITIVE_INFINITY &&
      d <= expectedDist &&
      !shareTip(b as keyof typeof branchTips, stageBranch)
    );

  const tieOrBetterOther = competingBranches.length > 0;

  debug(`Detected: ${detected}`);

  debug(`Expected Distance: ${expectedDist}`);

  debug(`Tie or Better Other: ${tieOrBetterOther}`);

  const stageForkMatchesHead = Boolean(
    forkPoints[stageBranch] &&
    branchTips[stageBranch] &&
    forkPoints[stageBranch] === branchTips[stageBranch]
  );

  const ok = (detected === stageBranch && !tieOrBetterOther) || (detected === stageBranch && stageForkMatchesHead);

  debug(`OK: ${ok}`);

  if (!ok) {
    const rule = `The hotfix branch intended for the \`${stageBranch}\` stage must be branched from \`${stageBranch}\`.`;
    const details =
      `[^note]: Distances (commits since fork point): ` +
      `\`develop\`=**${dDevelop === Number.POSITIVE_INFINITY ? "∞" : dDevelop}** ` +
      `\`main\`=**${dMain === Number.POSITIVE_INFINITY ? "∞" : dMain}** ` +
      `\`release\`=**${dRelease === Number.POSITIVE_INFINITY ? "∞" : dRelease}**.`;

    const closerBranch = tieOrBetterOther && detected === stageBranch
      ? competingBranches.reduce((best, current) => {
          const [, bestDist] = best;
          const [, currDist] = current;
          if (currDist === Number.POSITIVE_INFINITY) {
            return best;
          }
          if (bestDist === Number.POSITIVE_INFINITY || currDist < bestDist) {
            return current;
          }
          return best;
        })?.[0] ?? detected
      : detected;

    await summary
      .addRaw(rule, true)
      .addRaw(`Branch \`${branch}\` appears closer to \`${closerBranch}\`. [^note]`, true)
      .addRaw(details, true)
      .write();

    throw new Error(`Hotfix branch "${branch}" is not uniquely based on "${stageBranch}".`);
  }
}

export async function prepareRepository(gitRemoteUrl: URL, branch: string): Promise<void> {
  const email = `${gitRemoteUrl.username}@users.noreply.github.com`;
  try {
    await shell('git', ['config', '--global', 'user.email'], { shouldRejectOnError: true });
  } catch (error) {
    info(`Git user.email not set. Setting to ${email}.`);
    await shell('git', ['config', '--global', 'user.email', email], { shouldRejectOnError: true });
  }
  try {
    await shell('git', ['config', '--global', 'user.name'], { shouldRejectOnError: true });
  } catch (error) {
    info(`Git user.name not set. Setting to ${gitRemoteUrl.username}.`);
    await shell('git', ['config', '--global', 'user.name', gitRemoteUrl.username], { shouldRejectOnError: true });
  }
  try {
    await shell('git', ['status'], { shouldRejectOnError: true });
  } catch (error) {
    const href = gitRemoteUrl.href;
    info(`Git repository not found. Cloning repository from ${href}.`);
    await shell('git', ['clone', '--branch', branch, href, '.'], { shouldRejectOnError: true });
    await shell('git', ['remote', 'set-url', 'origin', href], { shouldRejectOnError: true });
    await shell('git', ['fetch', 'origin', '--prune'], { shouldRejectOnError: true });
  }
  await shell('git', ['fetch', 'origin', branch], { shouldRejectOnError: true });
  await shell('git', ['checkout', '-B', branch, `origin/${branch}`], { shouldRejectOnError: true });
}
