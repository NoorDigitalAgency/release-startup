import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import { wait, versioning } from './functions';

async function run(): Promise<void> {

  try {

    const stage = core.getInput('stage', { required: true });

    const reference = core.getInput('reference');

    const hotfix = core.getBooleanInput('hotfix');

    if (!['production', 'beta', 'alpha'].includes(stage)) {

      throw new Error(`Invalid stage name '${stage}'.`);
    }

    if (hotfix && stage !== 'production') {

      throw new Error(`A hotfix can only be released on 'production' while '${stage}' is specified.`);
    }

    const target = stage === 'alpha' ? 'develop' : stage === 'beta' ? 'release' : 'main';

    const source = stage === 'alpha' || stage === 'beta' ? 'develop' : 'beta';

    if (reference === target) {

      throw new Error(`Cannot reference '${reference}' while releasing to ${stage}.`);
    }

    if (stage === 'beta' && reference !== '' && !/^v20\d{2}\.\d{1,3}-alpha.\d{1,4}$/.test(reference)) {

      throw new Error(`The reference '${reference}' is not a release version from the 'alpha' stage.`);
    }

    const detached = !hotfix && reference !== '' && reference !== source;

    if (detached) {

      await exec.exec('git', ['fetch', '--all']);

      const exists = (await exec.getExecOutput('git', ['branch', '-r', '--contains', reference]))

        .stdout.split('\n').filter(line => line.trim() !== '').map(line => line.trim().split('/').pop())

        .includes(source);

      if (!exists) {

        throw new Error(`The reference '${reference}' could not be found on the base branch '${source}'.`);
      }
    }

    const octokit = new Octokit();

    const context = github.context;

    if (hotfix && (await octokit.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.every(branch => branch.name !== reference)) {

      throw new Error(`The hotfix branch '${reference}' could not be found.`);
    }

    const releases = [];

    let page = 1;

    let count;

    do {

      const pagedReleases = ((await octokit.rest.repos.listReleases({ owner: context.repo.owner, repo: context.repo.repo, page, per_page: 100 })).data);

      count = pagedReleases.length;

      releases.push(...pagedReleases.map(release => ({ tag: release.tag_name, branch: release.target_commitish, creation: Date.parse(release.created_at) })));

      page++;

    } while (count > 0);

    const prerelease = !hotfix && stage !== 'production';

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => b.creation - a.creation).reverse().map(release => release.tag).pop();

    const lastAlphaVersion = stage === 'alpha' ? previousVersion : releases.filter(release => release.branch === 'develop').sort((a, b) => b.creation - a.creation).reverse()

      .map(release => release.tag).pop();

    const lastProductionVersion = !prerelease ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => b.creation - a.creation).reverse()

      .map(release => release.tag).pop();

    const version = versioning(stage, reference, hotfix, prerelease, previousVersion, lastAlphaVersion, lastProductionVersion);

    core.setOutput('version', version);

    core.setOutput('previousVersion', previousVersion);

    if (!hotfix && !detached && target === source) {

      core.setOutput('reference', source);

    } else {

      const head = detached || hotfix ? reference : source;

      const title = `Automated ${hotfix ? 'hotfix' : stage} release version ${version} pull request`;

      let pull = (await octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: target, head, title })).data;

      while (pull.mergeable == null) {

        await wait(5000);

        pull = (await octokit.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number })).data;
      }

      if (!pull.mergeable) {

        await octokit.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`The pull request #${pull.number} '[FAILED] ${title}' is not mergeable.`);
      }

      const requests = [];

      if (hotfix) {

        requests.push(octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'release', head, title }));

        requests.push(octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'develop', head, title }));
      }

      const merge = (await octokit.pulls.merge({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, merge_method: 'merge' })).data;

      if (merge.merged) {

        core.setOutput('reference', merge.sha);

      } else {

        await octokit.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`Failed to merge the pull request #${pull.number} '[FAILED] ${title}'.`);
      }

      Promise.all(requests);
    }

  } catch (error) {

    if (error instanceof Error) core.setFailed(error.message)
  }
}

run();
