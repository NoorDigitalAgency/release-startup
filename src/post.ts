import * as core from '@actions/core';
import * as github from '@actions/github';
import { stringify } from 'flatted';

async function run(): Promise<void> {

  try {

    const token = core.getInput('token');

    if (core.getState('delete') === 'true') {

      const context = github.context;

      const octokit = github.getOctokit(token);

      const branch = core.getState('branch');

      core.debug(`Attempting to delete the temporary branch '${branch}'`);

      await octokit.rest.git.deleteRef({ owner: context.repo.owner, repo: context.repo.repo, ref: `heads/${branch}` });

      core.debug(`Branch '${branch}' is deleted.`);

    }

  } catch (error) {

    core.debug(`Error: ${stringify(error)}`);

    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
