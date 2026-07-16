import { rmSync, writeFileSync } from 'node:fs';

/**
 * Write or refresh BLOCKED_NO_MERGE.md when gates fail.
 * @param {string} path Absolute path to the file.
 * @param {Array<{gate:string, command:string, summary:string}>} failedGates
 * @param {string} commit Current HEAD commit SHA.
 */
export function writeBlockedFile(path, failedGates, commit) {
  const failedLines = failedGates.map((gate) => `- \`${gate.gate}\`: ${gate.summary}`).join('\n');
  const content = [
    '# BLOCKED_NO_MERGE',
    '',
    '- Repository: AgentWorkforce/agents',
    '- Branch: codex/issue-2619-agents-closure',
    `- Commit at block report: ${commit}`,
    '',
    '## Failed gates',
    '',
    failedLines,
    '',
    '## Exact failing commands',
    '',
    ...failedGates
      .map((gate) => [`### ${gate.gate}`, '', '```sh', gate.command, '```', '', `Summary: ${gate.summary}`, ''])
      .flat(),
    '## Release / merge confirmation',
    '',
    '- No PR was merged from this red acceptance evidence.',
    '- No package release was published from this worktree.',
    '',
  ].join('\n');
  writeFileSync(path, content);
}

/**
 * Remove BLOCKED_NO_MERGE.md when all gates pass. Silent if the file is absent
 * (ENOENT). Re-throws permission errors and other I/O failures so a stale
 * no-merge marker cannot be left behind undetected.
 * @param {string} path Absolute path to the file.
 */
export function removeBlockedFile(path) {
  try {
    rmSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
