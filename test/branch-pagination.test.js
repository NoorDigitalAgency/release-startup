const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchBranches } = require('../lib/functions');

test('fetchBranches includes branches returned on later pages', async () => {
  const pages = [[{ name: 'main' }], [{ name: 'release' }]];
  let options;
  const octokit = {
    rest: { repos: { listBranches() {} } },
    async paginate(_listBranches, requestOptions) {
      options = requestOptions;
      return pages.flat();
    }
  };

  const branches = await fetchBranches(octokit, 'owner', 'repo');

  assert.deepEqual(options, { owner: 'owner', repo: 'repo', per_page: 100 });
  assert.equal(branches.some(branch => branch.name === 'release'), true);
});
