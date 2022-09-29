import { getInput, debug, info, getBooleanInput, startGroup, endGroup, setOutput, saveState, warning, exportVariable, setFailed, notice } from '@actions/core';
import { getOctokit, context } from '@actions/github';
import { rmRF } from '@actions/io';
import { create } from '@actions/artifact';
import { wait, versioning } from './functions';
import { inspect as stringify } from 'util';
import { writeFileSync } from 'fs';

async function run(): Promise<void> {

  try {

    const token = getInput('token', { required: true });

    debug(`Token: '${token}'`);

    const stage = getInput('stage', { required: true });

    info(`Stage is: '${stage}'`);

    const reference = getInput('reference');

    info(`Reference is: '${reference}'`);

    const hotfix = getBooleanInput('hotfix');

    info(`Hotfix is: ${hotfix}`);

    const exports = getBooleanInput('exports');

    info(`Exports is: ${exports}`);

    const artifact = getBooleanInput('artifact');

    info(`Artifact is: ${artifact}`);

    const artifactName = getInput('artifact_name');

    info(`Artifact Name is: ${artifactName}`);

    if (!['production', 'beta', 'alpha'].includes(stage)) {

      throw new Error(`Invalid stage name '${stage}'.`);
    }

    if (hotfix && stage !== 'production') {

      throw new Error(`A hotfix can only be released on 'production' but '${stage}' is specified as the stage.`);
    }

    const target = stage === 'alpha' ? 'develop' : stage === 'beta' ? 'release' : 'main';

    info(`Target of release: '${target}'`);

    const source = stage === 'alpha' || stage === 'beta' ? 'develop' : 'release';

    info(`Source of release: '${source}'`);

    if (reference === target) {

      throw new Error(`Cannot reference '${reference}' while releasing to '${stage}'.`);
    }

    if (stage === 'beta' && reference !== '' && !/^v20\d{2}\.\d{1,3}-alpha.\d{1,4}$/.test(reference)) {

      throw new Error(`The reference '${reference}' is not a release version from the 'alpha' stage.`);
    }

    const detached = !hotfix && reference !== '' && reference !== source;

    debug(`Detached: ${detached}`);

    const octokit = getOctokit(token);

    startGroup('GitHub Context');

    debug(stringify(context, { depth: 5 }));

    endGroup();

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

      releases.push(...pagedReleases.filter(release => release.tag_name.startsWith('v20')).map(release => ({

        tag: release.tag_name, branch: release.tag_name.includes('-alpha.') ? 'develop' :

        release.tag_name.includes('-beta.') ? 'release' : 'main', creation: Date.parse(release.published_at ?? release.created_at), published: !release.draft

      })));

      page++;

    } while (count > 0);

    startGroup('Releases');

    debug(`Releases: ${stringify(releases)}`);

    endGroup();

    const previousVersion = releases.filter(release => release.branch === target).sort((a, b) => a.creation - b.creation).map(release => release.tag).pop();

    info(`Previous version: '${previousVersion ?? ''}'`);

    const lastAlphaVersion = stage === 'alpha' ? previousVersion : releases.filter(release => release.branch === 'develop').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    debug(`Last Alpha Version: ${lastAlphaVersion ? `'${lastAlphaVersion}'` : 'null'}`);

    const lastProductionVersion = stage === 'production' ? previousVersion : releases.filter(release => release.branch === 'main').sort((a, b) => a.creation - b.creation)

      .map(release => release.tag).pop();

    debug(`Last Production Version: ${lastProductionVersion ? `'${lastProductionVersion}'` : 'null'}`);

    const version = versioning(stage, reference, hotfix, stage === 'beta' ? lastAlphaVersion : previousVersion, lastProductionVersion);

    const plainVersion = version.substring(1);

    const extendedVersion = hotfix ? version : version.replace(/^(v20\d+\.\d+)(-(?:alpha|beta)\.\d+|)$/img, "$1.0$2");

    notice(`Release Version: ${version}`);

    if (releases.some(release => release.tag === version)) {

      throw new Error(`Release version '${version}' already exists.`);

    }

    info(`Version: '${version}'`);

    setOutput('version', version);

    setOutput('plain_version', plainVersion);

    setOutput('extended_version', extendedVersion);

    setOutput('previous_version', previousVersion);

    saveState('delete', false);

    let gitReference;

    if (stage === 'alpha') {

      if (reference !== '' && reference !== 'develop' && typeof previousVersion === 'string') {

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head: reference, base: previousVersion })).data.status;

        debug(`Status #1: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`Reference '${reference}' is not ahead of the previous release '${previousVersion}'.`);
        }
      }

      if ((reference === '' || reference === 'develop') && typeof previousVersion === 'string') {

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head: 'develop', base: previousVersion })).data.status;

        debug(`Status #2: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`No new changes in 'develop' since release version '${previousVersion}'.`);
        }
      }

      gitReference = detached ? reference : 'develop';

      info(`Reference: '${gitReference}'`);

      setOutput('reference', gitReference);

    } else {

      let head = hotfix ? reference : null;

      if (!hotfix) {

        const ref = detached ? reference : releases.filter(release => release.branch === source && release.published).sort((a, b) => a.creation - b.creation).map(release => release.tag).pop();

        if (typeof ref !== 'string') {

          throw new Error(`No suitable version found on '${source}' and no 'reference' was provided either.`);
        }

        debug(`Git Ref: '${ref}'`);

        const gitReference = (await octokit.rest.git.getRef({ owner: context.repo.owner, repo: context.repo.repo, ref: `tags/${ref}` })).data;

        const sha = gitReference.object.type === 'commit' ? gitReference.object.sha : (await octokit.rest.git.getTag({ owner: context.repo.owner, repo: context.repo.repo, tag_sha: gitReference.object.sha })).data.object.sha;

        debug(`SHA: '${sha}'`);

        const branchName = `rebase-${sha}-rsa`;

        await octokit.rest.git.createRef({ owner: context.repo.owner, repo: context.repo.repo, sha, ref: `refs/heads/${branchName}` });

        debug(`Temporary Branch Name: '${branchName}'`);

        saveState('branch', branchName);

        saveState('delete', true);

        head = branchName;

        const status = (await octokit.rest.repos.compareCommits({ owner: context.repo.owner, repo: context.repo.repo, head, base: target })).data.status;

        debug(`Status #3: '${status}'`);

        if (!['ahead', 'diverged'].includes(status)) {

          throw new Error(`${detached ? `Reference '${reference}'` : `Version '${ref}'`} is not ahead of the branch '${target}'.`);
        }
      }

      debug(`Head: ${head != null ? `'${head}'` : 'null'}`);

      if (typeof head !== 'string') {

        throw new Error(`Invalid 'head' value for creating a pull request.`);
      }

      const title = `Generated PR for ${hotfix ? 'hotfix' : stage}/${version}`;

      const body = `A pull request generated by [release-startup](https://github.com/NoorDigitalAgency/release-startup "Release Startup Action") action for **${hotfix ? 'hotfix' : stage}** release version **${version}**.`;

      debug(`Title: '${title}'`);

      let pull = (await octokit.rest.pulls.create({ owner: context.repo.owner, repo: context.repo.repo, base: target, head, title, body })).data;

      while (pull.mergeable == null) {

        await wait(5000);

        pull = (await octokit.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number })).data;
      }

      debug(`Mergeable: ${pull.mergeable}`);

      if (!pull.mergeable) {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}` });

        throw new Error(`The pull request #${pull.number} '[FAILED] ${title}' is not mergeable.`);
      }

      const merge = (await octokit.rest.pulls.merge({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, merge_method: 'merge' })).data;

      debug(`Merged: ${merge.merged}`);

      if (merge.merged) {

        info(`Reference: '${merge.sha}'`);

        setOutput('reference', merge.sha);

        gitReference = merge.sha;

      } else {

        await octokit.rest.pulls.update({ owner: context.repo.owner, repo: context.repo.repo, pull_number: pull.number, state: 'closed', title: `[FAILED] ${title}` });

        throw new Error(`Failed to merge the pull request #${pull.number} '[FAILED] ${title}'.`);
      }
    }

    if (exports) {

      debug('Attempting to export the environment varibales.');

      exportVariable('RELEASE_VERSION', version);

      exportVariable('RELEASE_PLAIN_VERSION', plainVersion);

      exportVariable('RELEASE_EXTENDED_VERSION', extendedVersion);

      exportVariable('RELEASE_PREVIOUS_VERSION', previousVersion);

      exportVariable('RELEASE_REFERENCE', gitReference);

      debug('Exported the environment varibales.');
    }

    if (artifact) {

      debug('Attempting to start the artifact creation.');

      const file = `${artifactName}.json`;

      debug(`Artifact File: ${file}`);

      writeFileSync(file, JSON.stringify({ version, plainVersion, extendedVersion, previousVersion, reference: gitReference }));

      debug('Created artifact file.');

      const client = create();

      try {

        debug('Attempting to upload the artifact file.');

        await client.uploadArtifact(artifactName, [file], '.', { retentionDays: 1, continueOnError: false });

        debug('Artifact file uploaded.');

      } catch (error) {

        startGroup('Artifact Error');

        debug(`${stringify(error, { depth: 5 })}`);

        endGroup();

        throw new Error('Problem in uploading the artifact file.');
      }

      try {

        debug('Attempting to delete the artifact file.');

        rmRF(file);

        debug('Artifact file deleted.');

      } catch (error) {

        warning('Problem in deleting the artifact file.');

        startGroup('Artifact File Deletion Error');

        debug(`${stringify(error, { depth: 5 })}`);

        endGroup();
      }
    }

  } catch (error) {

    startGroup('Error');

    debug(`${stringify(error, { depth: 5 })}`);

    endGroup();

    if (error instanceof Error) setFailed(error.message);
  }
}

run();
