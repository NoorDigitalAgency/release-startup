import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';

async function run(): Promise<void> {

  try {

    const stage = core.getInput('stage', { required: true });

    const commit = core.getInput('commit');

    if (!['production', 'beta', 'alpha'].includes(stage)) {

      throw new Error(`Invalid stage name '${stage}'.`);
    }

    const branch = stage === 'alpha' ? 'develop' : stage === 'beta' ? 'release' : 'main';

    const detached = commit !== '' && commit !== branch;

    await exec.exec('git', ['fetch', '--all']);

    const correctBranch = !detached || (await exec.getExecOutput('git', ['branch', '-r', '--contains', commit]))

      .stdout.split('\n').filter(line => line.trim() !== '').map(line => line.trim().split('/').pop())

      .includes(branch);

    if (!correctBranch) {

      throw new Error(`The commit '${commit}' doesn't exist on branch '${branch}'.`);
    }

    core.setOutput('commit', commit);

    const octokit = new Octokit();

    const context = github.context;

    const releases = [];

    let page = 1;

    let count;

    do {

      const pagedReleases = (await octokit.rest.repos.listReleases({ owner: context.repo.owner, repo: context.repo.repo, page, per_page: 100 })).data;

      count = pagedReleases.length;

      releases.push(...pagedReleases.map(release => ({ tag: release.tag_name, branch: release.target_commitish, creation: Date.parse(release.created_at) })));

      page++;

    } while (count > 0);

    const previousVersion = releases.filter(release => release.branch === branch).sort((a, b) => b.creation - a.creation).reverse().map(release => release.tag).pop();

    const lastMainVersion = branch === 'main' ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => b.creation - a.creation).reverse()
    
      .map(release => release.tag).pop();

    const version = `v0.9.${Math.trunc(Math.random() * 10000)}`;

    core.setOutput('version', version);

    core.setOutput('previousVersion', previousVersion);

  } catch (error) {

    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
