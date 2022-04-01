import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { wait, versioning } from './functions';
import { stringify } from 'flatted';

async function run(): Promise<void> {

  try {

    core.info('Starting up...');

    const token = core.getInput('token');

    core.debug(`Token: '${token}'`);

    const stage = core.getInput('stage', { required: true });

    core.info(`Stage is: '${stage}'`);

    const reference = core.getInput('reference');

    core.info(`Reference is: '${reference}'`);

    const hotfix = core.getBooleanInput('hotfix');

    core.info(`Hotfix is: ${hotfix}`);

    if (!['production', 'beta', 'alpha'].includes(stage)) {

      throw new Error(`Invalid stage name '${stage}'.`);
    }

    if (hotfix && stage !== 'production') {

      throw new Error(`A hotfix can only be released on 'production' but '${stage}' is specified as the stage.`);
    }

    const target = stage === 'alpha' ? 'develop' : stage === 'beta' ? 'release' : 'main';

    core.info(`Target of release: '${target}'`);

    const source = stage === 'alpha' || stage === 'beta' ? 'develop' : 'release';

    core.info(`Source of release: '${source}'`);

    if (reference === target) {

      throw new Error(`Cannot reference '${reference}' while releasing to ${stage}.`);
    }

    if (stage === 'beta' && reference !== '' && !/^v20\d{2}\.\d{1,3}-alpha.\d{1,4}$/.test(reference)) {

      throw new Error(`The reference '${reference}' is not a release version from the 'alpha' stage.`);
    }

    const detached = !hotfix && reference !== '' && reference !== source;

    core.debug(`Detached: ${detached}`);

    if (detached) {

      core.debug(`Git Fetch All: ${await (await exec.getExecOutput('git', ['fetch', '--all'])).stdout}`);

      const exists = (await exec.getExecOutput('git', ['branch', '-r', '--contains', reference]))

        .stdout.split('\n').filter(line => line.trim() !== '').map(line => line.trim().split('/').pop())

        .includes(source);

      core.debug(`Exists: ${exists}`);

      if (!exists) {

        throw new Error(`The reference '${reference}' could not be found on the base branch '${source}'.`);
      }
    }

    core.debug(`GitHub Object: ${stringify(github.context)}`);

    const octokit = github.getOctokit(token);

    const context = github.context;

    if (hotfix && (reference === '' || (await octokit.rest.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.every(branch => branch.name !== reference))) {

      throw new Error(reference === '' ? 'The hotfix branch name (\'reference\') cannot be empty.' : `The hotfix branch '${reference}' could not be found.`);
    }

    const releases = [];

    let page = 1;

    let count;

    do {

      const pagedReleases = ((await octokit.rest.repos.listReleases({ owner: context.repo.owner, repo: context.repo.repo, page, per_page: 100 })).data);

      count = pagedReleases.length;

      releases.push(...pagedReleases.map(release => ({ tag: release.tag_name, branch: release.target_commitish, creation: Date.parse(release.created_at), published: !release.draft })));

      page++;

    } while (count > 0);

    core.debug(`Releases: ${stringify(releases)}`);

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => a.creation - b.creation).map(release => release.tag).pop();

    core.info(`Previous version: '${previousVersion ?? ''}'`);

    const lastAlphaVersion = stage === 'alpha' ? previousVersion : releases.filter(release => release.branch === 'develop').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    core.debug(`Last Alpha Version: ${lastAlphaVersion ? `'${lastAlphaVersion}'` : 'null'}`);

    const lastProductionVersion = stage === 'production' ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    core.debug(`Last Production Version: ${lastProductionVersion ? `'${lastProductionVersion}'` : 'null'}`);

    const version = versioning(stage, reference, hotfix, stage === 'beta' ? lastAlphaVersion : previousVersion, lastProductionVersion);

    core.info(`Version: '${version}'`);

    core.setOutput('version', version);

    core.setOutput('previous-version', previousVersion);

    if (stage === 'alpha') {

      core.info(`Reference: '${ detached ? reference : 'develop'}'`);

      core.setOutput('reference', 'develop');

    } else {

      let head = hotfix ? reference : null;

      if (!hotfix) {

        const ref = detached ? reference : releases.filter(release => release.branch === source && release.published).sort((a, b) => a.creation - b.creation).map(release => release.tag).pop();

        if (typeof ref !== 'string') {

          throw new Error(`No suitable version found on '${source}' and no 'reference' was provided either.`);
        }

        core.debug(`Git Ref: '${ref}'`);

        const gitReference = (await octokit.rest.git.getRef({ owner: context.repo.owner, repo: context.repo.repo, ref: `tags/${ref}` })).data;

        const sha = gitReference.object.type === 'commit' ? gitReference.object.sha : (await octokit.rest.git.getTag({ owner: context.repo.owner, repo: context.repo.repo, tag_sha: gitReference.object.sha })).data.object.sha;

        core.debug(`SHA: '${sha}'`);

        const branchName = `release-startup-${sha}-branch`;

        core.debug(`Temporary Branch Name: '${branchName}'`);

        await octokit.rest.git.createRef({ owner: context.repo.owner, repo: context.repo.repo, sha, ref: `heads/${branchName}`});

        head = branchName;
      }

      core.debug(`Head: ${head != null ? `'${head}'` : 'null'}`);

      if (typeof head !== 'string') {

        throw new Error(`Invalid 'head' value for creating a pull request.`);
      }

      const title = `Generated PR for ${hotfix ? 'hotfix' : stage}/${version}`;

      const body = `A pull request generated by [release-startup](https://github.com/NoorDigitalAgency/release-startup "Release automation startup tasks") action for **${hotfix ? 'hotfix' : stage}** release version **${version}**.`;

      core.debug(`Title: '${title}'`);

      let pull = (await octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: target, head, title, body })).data;

      while (pull.mergeable == null) {

        await wait(5000);

        pull = (await octokit.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number })).data;
      }

      core.debug(`Mergeable: ${pull.mergeable}`);

      if (!pull.mergeable) {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`The pull request #${pull.number} '[FAILED] ${title}' is not mergeable.`);
      }

      const requests = [];

      if (hotfix) {

        core.info(`Creating merge requests for 'develop' and 'release' branches.`);

        requests.push(octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'release', head, title, body }));

        requests.push(octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'develop', head, title, body }));
      }

      const merge = (await octokit.rest.pulls.merge({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, merge_method: 'merge' })).data;

      core.debug(`Merged: ${merge.merged}`);

      if (merge.merged) {

        core.info(`Reference: '${reference}'`);

        core.setOutput('reference', merge.sha);

      } else {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`Failed to merge the pull request #${pull.number} '[FAILED] ${title}'.`);
      }

      Promise.all(requests);
    }

  } catch (error) {

    core.debug(`Error: ${stringify(error)}`);

    if (error instanceof Error) core.setFailed(error.message)
  }
}

run();
