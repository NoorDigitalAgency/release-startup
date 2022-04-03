import * as core from '@actions/core';
import * as github from '@actions/github';
import { rmRF } from '@actions/io';
import { create } from '@actions/artifact';
import { wait, versioning } from './functions';
import { inspect as stringify } from 'util';
import { writeFileSync } from 'fs';

async function run(): Promise<void> {

  try {

    const token = core.getInput('token');

    core.debug(`Token: '${token}'`);

    const stage = core.getInput('stage', { required: true });

    core.info(`Stage is: '${stage}'`);

    const reference = core.getInput('reference');

    core.info(`Reference is: '${reference}'`);

    const hotfix = core.getBooleanInput('hotfix');

    core.info(`Hotfix is: ${hotfix}`);

    const exports = core.getBooleanInput('exports');

    core.info(`Exports is: ${exports}`);

    const artifact = core.getBooleanInput('artifact');

    core.info(`Artifact is: ${artifact}`);

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

      throw new Error(`Cannot reference '${reference}' while releasing to '${stage}'.`);
    }

    if (stage === 'beta' && reference !== '' && !/^v20\d{2}\.\d{1,3}-alpha.\d{1,4}$/.test(reference)) {

      throw new Error(`The reference '${reference}' is not a release version from the 'alpha' stage.`);
    }

    const detached = !hotfix && reference !== '' && reference !== source;

    core.debug(`Detached: ${detached}`);

    const octokit = github.getOctokit(token);

    const context = github.context;

    core.startGroup('GitHub Context');

    core.debug(stringify(context, { depth: 5 }));

    core.endGroup();

    if (detached && !['behind', 'identical'].includes((await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, base: source, head: reference })).data.status)) {

      throw new Error(`The reference '${reference}' could not be found on the base branch '${source}'.`);
    }

    if ((await octokit.rest.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.every(branch => branch.name !== source)) {

      throw new Error(`The source branch '${source}' was not found.`);
    }

    if (hotfix && (reference === '' || (await octokit.rest.repos.listBranches({ owner: context.repo.owner, repo: context.repo.repo })).data.every(branch => branch.name !== reference))) {

      throw new Error(reference === '' ? 'The hotfix branch name (\'reference\') cannot be empty.' : `The hotfix branch '${reference}' could not be found.`);
    }

    const releases = [];

    let page = 1;

    let count;

    do {

      const pagedReleases = ((await octokit.rest.repos.listReleases({ owner: context.repo.owner, repo: context.repo.repo, page, per_page: 100 })).data);

      count = pagedReleases.length;

      releases.push(...pagedReleases.filter(release => release.name?.startsWith('v20')).map(release => ({ tag: release.tag_name, branch: release.tag_name.includes('-alpha.') ?
      
        'develop' : release.tag_name.includes('-beta.') ? 'release' : 'main', creation: Date.parse(release.published_at ?? release.created_at), published: !release.draft })));

      page++;

    } while (count > 0);

    core.startGroup('Releases');

    core.debug(`Releases: ${stringify(releases)}`);

    core.endGroup();

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => a.creation - b.creation).map(release => release.tag).pop();

    core.info(`Previous version: '${previousVersion ?? ''}'`);

    const lastAlphaVersion = stage === 'alpha' ? previousVersion : releases.filter(release => release.branch === 'develop').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    core.debug(`Last Alpha Version: ${lastAlphaVersion ? `'${lastAlphaVersion}'` : 'null'}`);

    const lastProductionVersion = stage === 'production' ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    core.debug(`Last Production Version: ${lastProductionVersion ? `'${lastProductionVersion}'` : 'null'}`);

    const version = versioning(stage, reference, hotfix, stage === 'beta' ? lastAlphaVersion : previousVersion, lastProductionVersion);

    if (releases.some(release => release.tag === version)) {

      throw new Error(`Release version '${version}' already exists.`);
      
    }

    core.info(`Version: '${version}'`);

    core.setOutput('version', version);

    core.setOutput('previous_version', previousVersion);

    core.saveState('delete', false);

    let gitReference;

    if (stage === 'alpha') {

      if (reference !== '' && reference !== 'develop' && typeof previousVersion === 'string') {

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head: reference, base: previousVersion })).data.status;

        core.debug(`Status #1: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`Reference '${reference}' is not ahead of the previous release '${previousVersion}'.`);
        }
      }

      if ((reference === '' || reference === 'develop') && typeof previousVersion === 'string') {

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head: 'develop', base: previousVersion })).data.status;

        core.debug(`Status #2: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`No new changes in 'develop' since release version '${previousVersion}'.`);
        }
      }

      gitReference = detached ? reference : 'develop';

      core.info(`Reference: '${gitReference}'`);

      core.setOutput('reference', gitReference);

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

        const branchName = `dawn-action-${sha}`;

        await octokit.rest.git.createRef({ owner: context.repo.owner, repo: context.repo.repo, sha, ref: `refs/heads/${branchName}`});

        core.debug(`Temporary Branch Name: '${branchName}'`);

        core.saveState('branch', branchName);

        core.saveState('delete', true);

        head = branchName;

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head, base: target })).data.status;

        core.debug(`Status #3: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`${detached ? `Reference '${reference}'` : `Version '${ref}'`} is not ahead of the branch '${target}'.`);
        }
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

        core.info(`Reference: '${merge.sha}'`);

        core.setOutput('reference', merge.sha);

        gitReference = merge.sha;

      } else {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}`});

        throw new Error(`Failed to merge the pull request #${pull.number} '[FAILED] ${title}'.`);
      }

      try {

        if (requests.length > 0) {

          core.debug('Waiting for creation of merge-back pull requests for hotfix.');

          await Promise.all(requests);

          core.debug('Merge-back pull requests for hotfix created.');
        }

      } catch (error) {

        core.warning('Problem in creating merge-back pull requests for hotfix.');

        core.startGroup('Merge-Back Pull Request Error');

        core.debug(`${stringify(error, { depth: 5 })}`);

        core.endGroup();
      }
    }

    if (exports) {

      core.debug('Attempting to export the environment varibales.');

      core.exportVariable('RELEASE_STARTUP_VERSION', version);

      core.exportVariable('RELEASE_STARTUP_PREVIOUS_VERSION', previousVersion);

      core.exportVariable('RELEASE_STARTUP_GIT_REFERENCE', gitReference);

      core.debug('Exported the environment varibales.');
    }

    if (artifact) {

      core.debug('Attempting to start the artifact creation.');

      const file = 'release-startup-outputs-artifact.json';

      core.debug(`Artifact File: ${file}`);

      writeFileSync(file, JSON.stringify({ version, previousVersion, reference: gitReference }));

      core.debug('Created artifact file.');

      const client = create();

      try {

        core.debug('Attempting to upload the artifact file.');

        await client.uploadArtifact('release-startup-outputs', [file], '.', { retentionDays: 1, continueOnError: false });

        core.debug('Artifact file uploaded.');

      } catch (error) {

        core.startGroup('Artifact Error');

        core.debug(`${stringify(error, { depth: 5 })}`);

        core.endGroup();

        throw new Error('Problem in uploading the artifact file.');
      }

      try {

        core.debug('Attempting to delete the artifact file.');

        rmRF(file);

        core.debug('Artifact file deleted.');

      } catch (error) {

        core.warning('Problem in deleting the artifact file.');

        core.startGroup('Artifact File Deletion Error');

        core.debug(`${stringify(error, { depth: 5 })}`);

        core.endGroup();
      }
    }

  } catch (error) {

    core.startGroup('Error');

    core.debug(`${stringify(error, { depth: 5 })}`);

    core.endGroup();

    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
