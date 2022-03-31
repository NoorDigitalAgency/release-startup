import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';

function wait(milliseconds: number) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

    const detached = !hotfix && reference !== '' && reference !== source;

    if (detached) {

      await exec.exec('git', ['fetch', '--all']);

      const exists = !detached || (await exec.getExecOutput('git', ['branch', '-r', '--contains', reference]))

        .stdout.split('\n').filter(line => line.trim() !== '').map(line => line.trim().split('/').pop())

        .includes(source);

      if (!exists) {

        throw new Error(`The commit '${reference}' doesn't exist on the base branch '${source}'.`);
      }
    }

    const octokit = new Octokit();

    const context = github.context;

    if ((await octokit.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.some(branch => branch.name === reference)) {

      throw new Error(`The hotfix branch '${reference}' doesn't exist.'`);
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

    const prerelease = target !== 'main';

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => b.creation - a.creation).reverse().map(release => release.tag).pop();

    const lastMainVersion = !prerelease ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => b.creation - a.creation).reverse()

      .map(release => release.tag).pop();

    //TODO: Calculate the next version
    const version = `v0.9.${Math.trunc(Math.random() * 1000)}`;

    core.setOutput('version', version);

    core.setOutput('previousVersion', previousVersion);

    if (detached || hotfix) {

      const head = reference !== '' ? reference : source;

      const title = `automated ${hotfix ? 'hotfix' : stage} release version ${version}`;

      let pull = (await octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: target, head, title })).data;

      while (pull.mergeable == null) {

        await wait(5000);

        pull = (await octokit.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number })).data;
      }

      if (!pull.mergeable) {

        await octokit.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[failed] ${title}`});

        throw new Error(`The source '${hotfix ? reference : source}' is not mergeable into '${target}'.`);
      }

      if (hotfix) {

        octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'release', head, title });

        octokit.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: 'develop', head, title });
      }

      const merge = (await octokit.pulls.merge({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, merge_method: 'merge' })).data;

      if (merge.merged) {

        core.setOutput('reference', merge.sha);

      } else {

        await octokit.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[failed] ${title}`});

        throw new Error(`Failed to merge the pull request #${pull.number} '[failed] ${title}'.`);
      }
    }

  } catch (error) {

    if (error instanceof Error) core.setFailed(error.message)
  }
}

run();
