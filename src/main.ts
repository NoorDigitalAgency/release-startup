import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { wait, versioning } from './functions';

async function run(): Promise<void> {

  try {

    let token = core.getInput('github_token');

    token = token === '' ? process.env.INPUT_GITHUB_TOKEN ?? '' : token;

    core.debug(`Process: ${JSON.stringify(process)}`);

    core.debug(`Token: '${token}'`);

    const stage = core.getInput('stage', { required: true });

    core.debug(`Stage: '${stage}'`);

    const reference = core.getInput('reference');

    core.debug(`Reference: '${reference}'`);

    const hotfix = core.getBooleanInput('hotfix');

    core.debug(`Hotfix: ${hotfix}`);

    if (!['production', 'beta', 'alpha'].includes(stage)) {

      throw new Error(`Invalid stage name '${stage}'.`);
    }

    if (hotfix && stage !== 'production') {

      throw new Error(`A hotfix can only be released on 'production' but '${stage}' is specified as the stage.`);
    }

    const target = stage === 'alpha' ? 'develop' : stage === 'beta' ? 'release' : 'main';

    core.debug(`Target: '${target}'`);

    const source = stage === 'alpha' || stage === 'beta' ? 'develop' : 'beta';

    core.debug(`Source: '${source}'`);

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

    core.debug(`GitHub Object: ${JSON.stringify(github)}`);
    
    core.debug('Creating Octokit...');

    const octokit = github.getOctokit(token);
    
    core.debug('Octokit Created.');

    const context = github.context;

    if (hotfix && (reference === '' || (await octokit.rest.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.every(branch => branch.name !== reference))) {

      throw new Error(reference === '' ? 'The hotfix branch name (\'reference\') cannot be empty.' : `The hotfix branch '${reference}' could not be found.`);
    }

    const releases = [];

    let page = 1;

    let count;

    do {

      try {

        const pagedReleases = ((await octokit.rest.repos.listReleases({ owner: context.repo.owner, repo: context.repo.repo, page, per_page: 100 })).data);

        count = pagedReleases.length;

        releases.push(...pagedReleases.map(release => ({ tag: release.tag_name, branch: release.target_commitish, creation: Date.parse(release.created_at) })));

        page++;
        
      } catch {
        
        count = 0;
      }

    } while (count > 0);

    core.debug(`Releases: ${JSON.stringify(releases)}`);

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => b.creation - a.creation).reverse().map(release => release.tag).pop();

    core.debug(`Previous Version: '${previousVersion}'`);

    const lastAlphaVersion = stage === 'alpha' ? previousVersion : releases.filter(release => release.branch === 'develop').sort((a, b) => b.creation - a.creation).reverse()

      .map(release => release.tag).pop();

    core.debug(`Last Alpha Version: ${lastAlphaVersion ? `'${lastAlphaVersion}'` : 'null'}`);

    const lastProductionVersion = stage === 'production' ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => b.creation - a.creation).reverse()

      .map(release => release.tag).pop();

    core.debug(`Last Production Version: ${lastProductionVersion ? `'${lastProductionVersion}'` : 'null'}`);

    const version = versioning(stage, reference, hotfix, stage === 'beta' ? lastAlphaVersion : previousVersion, lastProductionVersion);

    core.debug(`Version: '${version}'`);

    core.setOutput('version', version);

    core.setOutput('previousVersion', previousVersion);

    if (!hotfix && !detached && target === source) {

      core.setOutput('reference', source);

      core.debug(`Reference: '${reference}'`);

    } else {

      const head = detached || hotfix ? reference : source;

      core.debug(`Head: '${head}'`);

      const title = `Automated ${hotfix ? 'hotfix' : stage} release version ${version} pull request`;

      core.debug(`Title: '${title}'`);

      let pull = (await octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: target, head, title })).data;

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

        requests.push(octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'release', head, title }));

        requests.push(octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'develop', head, title }));
      }

      const merge = (await octokit.rest.pulls.merge({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, merge_method: 'merge' })).data;

      core.debug(`Merged: ${merge.merged}`);

      if (merge.merged) {

        core.setOutput('reference', merge.sha);

      } else {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`Failed to merge the pull request #${pull.number} '[FAILED] ${title}'.`);
      }

      Promise.all(requests);
    }

  } catch (error) {

    core.debug(`Error: ${JSON.stringify(error)}`);

    if (error instanceof Error) core.setFailed(error.message)
  }
}

run();
