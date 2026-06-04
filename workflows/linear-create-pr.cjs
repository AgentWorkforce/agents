(async () => {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const argsPath = process.argv[2];
  if (!argsPath) throw new Error('open-pr args path is required');
  const args = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  const repoDir = readRequiredString(args, 'repoDir');
  const owner = readRequiredString(args, 'owner');
  const repo = readRequiredString(args, 'repo');
  const branch = readRequiredString(args, 'branch');
  const title = readRequiredString(args, 'title');
  const body = readRequiredString(args, 'body');

  const cloudApiUrl = readCredentialUrl('CLOUD_API_URL');
  const pullRequestAuthToken = readCredential('WORKFORCE_WORKSPACE_TOKEN') || readCredential('CLOUD_API_ACCESS_TOKEN');
  if (!cloudApiUrl) throw new Error('CLOUD_API_URL is required to open a PR');
  if (!pullRequestAuthToken) throw new Error('WORKFORCE_WORKSPACE_TOKEN or CLOUD_API_ACCESS_TOKEN is required to open a PR');

  const baseSha = readBaseSha();

  function readRequiredString(record, key) {
    const value = record && record[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('open-pr args.' + key + ' must be a non-empty string');
    }
    return value;
  }

  function readCredential(name) {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function readCredentialUrl(name) {
    return readCredential(name).replace(/\/+$/, '');
  }

  function gitLines(args) {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).split('\n').filter(Boolean);
  }

  function readBaseSha() {
    const marker = path.join(repoDir, '.linear-chat-base-sha');
    if (fs.existsSync(marker)) {
      const value = fs.readFileSync(marker, 'utf8').trim();
      if (value) return value;
    }
    return gitLines(['rev-parse', 'HEAD'])[0];
  }

  function collectDiffPaths() {
    const committedRange = baseSha + '..HEAD';
    const changed = Array.from(new Set([
      ...gitLines(['diff', '--name-only', '--diff-filter=ACMRT', committedRange]),
      ...gitLines(['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD']),
      ...gitLines(['ls-files', '--others', '--exclude-standard']),
    ])).filter((filePath) => filePath !== '.linear-chat-base-sha');
    const deleted = Array.from(new Set([
      ...gitLines(['diff', '--name-only', '--diff-filter=D', committedRange]),
      ...gitLines(['diff', '--name-only', '--diff-filter=D', 'HEAD']),
    ])).filter((filePath) => !changed.includes(filePath));
    return { changed, deleted };
  }

  const { changed, deleted } = collectDiffPaths();
  const files = [];
  for (const filePath of changed) {
    if (filePath.startsWith('.git/')) continue;
    files.push({
      path: filePath,
      content: fs.readFileSync(path.join(repoDir, filePath)).toString('base64'),
      encoding: 'base64',
    });
  }
  for (const filePath of deleted) {
    files.push({ path: filePath, deleted: true });
  }
  if (files.length === 0) throw new Error('No file changes to publish');

  const response = await fetch(cloudApiUrl + '/api/v1/github/pull-request', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + pullRequestAuthToken, 'content-type': 'application/json' },
    body: JSON.stringify({ owner, repo, branch, baseSha, baseBranch: 'main', title, body, files }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.prUrl) {
    throw new Error('Proxy PR create failed: ' + response.status + ' ' + JSON.stringify(payload));
  }
  console.log(payload.prUrl);
  console.log(branch);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
