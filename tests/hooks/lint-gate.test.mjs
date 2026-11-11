// caveman-gate.js lints what leaves the session (commits, PR and ticket text,
// markdown docs, the chat reply) and refuses or flags plain prose. These tests
// spawn the real hook against a throwaway CLAUDE_CONFIG_DIR and a real tracker
// for mode state and the per-turn reminder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = path.join(root, 'src/hooks/caveman-gate.js');
const TRACKER = path.join(root, 'src/hooks/caveman-mode-tracker.js');

const PLAIN = 'This change updates the handler so that the request is processed by the new middleware. '
  + 'It means that the users will no longer see the error when they open the page for the first time, '
  + 'and the team can remove the old workaround from the codebase.';

const CAVEMAN = 'Route requests through new middleware. Users no longer see error on first page open. '
  + 'Remove old workaround from codebase. Add regression test covering cold start path. '
  + 'Keep config flag default off until rollout finishes.';

function fixture(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'claude');
  const project = path.join(dir, 'project');
  fs.mkdirSync(config);
  fs.mkdirSync(project);
  const baseEnv = { ...process.env, HOME: dir, USERPROFILE: dir,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  delete baseEnv.CAVEMAN_DEFAULT_MODE;
  delete baseEnv.CAVEMAN_GATE;
  delete baseEnv.CLAUDE_CODE_ENTRYPOINT;

  const run = (script, payload, env = {}) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir, env: { ...baseEnv, ...extraEnv, ...env },
      input: typeof payload === 'string' ? payload : JSON.stringify({ session_id: 's1', cwd: project, ...payload }),
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const prompt = (text, sessionId = 's1') =>
    run(TRACKER, { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId });
  const pre = (tool_name, tool_input, env, extra) =>
    run(GATE, { hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }, env);
  const bash = (command, env) => pre('Bash', { command }, env);
  const stop = (message, extra) =>
    run(GATE, { hook_event_name: 'Stop', last_assistant_message: message, ...extra });
  const sessionFile = (ext) => path.join(config, '.caveman-sessions', 's1' + ext);
  return { dir, config, project, prompt, pre, bash, stop, run, sessionFile };
}

// doc-file skips tmp and scratch paths, so doc tests write under the repo, or
// under the real home dir when the checkout itself sits in a tmp or scratch dir.
function docDir(t) {
  const scratch = /^(?:\/private)?\/tmp\/|^\/var\/folders\/|[\\/]scratchpad[\\/]/i.test(root) || root.startsWith(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(scratch ? os.homedir() : root, '.gate-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const commit = (message) => `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`;

function denial(stdout) {
  const out = JSON.parse(stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

function reminder(stdout) {
  return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '';
}

test('plain-prose git commit heredoc is denied and the reason names rule and fix', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  const reason = denial(bash(commit('fix: handler\n\n' + PLAIN)));
  assert.match(reason, /^caveman gate: git-commit refused\./);
  assert.match(reason, /^articles: /m);
  assert.match(reason, /^long-sentence: /m);
  assert.match(reason, /drop a\/an\/the/);
  assert.ok(reason.length <= 650, `reason is ${reason.length} chars`);
});

test('caveman commit passes with empty stdout', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  assert.equal(bash(commit('fix: handler\n\n' + CAVEMAN + '\n\nCo-Authored-By: Claude <noreply@anthropic.com>')), '');
});

test('ceremony phrases are denied even in a short message', t => {
  const { prompt, bash } = fixture(t);
  prompt('/ultracave');
  assert.match(denial(bash('git commit -m "Actually just fix typo"')), /^ceremony: /m);
});

test('git commit -am and a commit without a message pass through the right paths', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  assert.match(denial(bash(`git commit -am "Basically ${PLAIN}"`)), /^ceremony: /m);
  assert.equal(bash('git commit --amend --no-edit'), '');
});

test('--body-file content is read relative to cwd', t => {
  const { prompt, pre, project } = fixture(t);
  prompt('/caveman');
  fs.writeFileSync(path.join(project, 'body.md'), PLAIN);
  const reason = denial(pre('Bash', { command: 'gh pr create --title "Handler" --body-file body.md' }, {}, { cwd: project }));
  assert.match(reason, /^caveman gate: gh-pr refused\./);
  fs.writeFileSync(path.join(project, 'body.md'), CAVEMAN);
  assert.equal(pre('Bash', { command: 'gh pr create --title "Handler" --body-file body.md' }, {}, { cwd: project }), '');
});

test('gh issue and gh api body fields are linted', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  assert.match(denial(bash(`gh issue comment 12 --body "${PLAIN}"`)), /gh-issue refused/);
  assert.match(denial(bash(`gh api repos/o/r/issues/1/comments -f body='${PLAIN}'`)), /gh-api refused/);
  assert.equal(bash('gh api repos/o/r/issues/1/comments -f labels=bug'), '');
});

test('a Jira-shaped MCP create is denied on its description', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  const input = {
    cloudId: 'c1',
    projectKey: 'MOB',
    summary: 'Handler fails',
    issueTypeName: 'Bug',
    description: PLAIN,
    additional_fields: { labels: ['mobile'] },
  };
  const reason = denial(pre('mcp__4eb9bb5f-e32f-441e-9871-f502f9cc7c0a__createJiraIssue', input));
  assert.match(reason, /^caveman gate: mcp-write refused\./);
  assert.equal(pre('mcp__4eb9bb5f-e32f-441e-9871-f502f9cc7c0a__createJiraIssue', { ...input, description: CAVEMAN }), '');
});

test('MCP read tools and harness servers are ignored', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  assert.equal(pre('mcp__4eb9bb5f-e32f-441e-9871-f502f9cc7c0a__getJiraIssue', { description: PLAIN }), '');
  assert.equal(pre('mcp__ccd_session__start_session', { message: PLAIN }), '');
  assert.equal(pre('mcp__Claude_Browser__form_input', { text: PLAIN }), '');
  assert.equal(pre('mcp__scheduled-tasks__create_scheduled_task', { description: PLAIN }), '');
});

test('non-sink Bash commands and tools print nothing', t => {
  const { prompt, bash, pre } = fixture(t);
  prompt('/caveman');
  assert.equal(bash('ls -la && git status'), '');
  assert.equal(bash(`echo "${PLAIN}"`), '');
  assert.equal(pre('Write', { file_path: '/repo/src/a.js', content: PLAIN }), '');
});

test('off, megacave and CAVEMAN_GATE=off print nothing', t => {
  const { prompt, bash } = fixture(t);
  const bad = commit(PLAIN);
  assert.equal(bash(bad), '', 'no mode stored yet');
  prompt('/caveman');
  assert.equal(bash(bad, { CAVEMAN_GATE: 'off' }), '');
  prompt('/megacave');
  assert.equal(bash(bad), '');
  prompt('stop caveman');
  assert.equal(bash(bad), '');
});

test('repo config gate key is honored', t => {
  const { prompt, bash, project } = fixture(t);
  prompt('/caveman');
  fs.writeFileSync(path.join(project, '.caveman.json'), '{"gate":"off"}');
  assert.equal(bash(commit(PLAIN)), '');
});

test('a session without a valid id is never gated', t => {
  const { prompt, run } = fixture(t);
  prompt('/caveman');
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: commit(PLAIN) } };
  assert.equal(run(GATE, { ...payload, session_id: '../x' }), '');
  assert.equal(run(GATE, { ...payload, session_id: undefined }), '');
});

test('third consecutive attempt passes and the counter resets', t => {
  const { prompt, bash, sessionFile } = fixture(t);
  prompt('/caveman');
  const bad = commit(PLAIN);
  denial(bash(bad));
  denial(bash(bad));
  assert.equal(bash(bad), '');
  assert.equal(fs.existsSync(sessionFile('.gate')), false);
  assert.match(prompt('next'), /Last git-commit broke caveman/);
  denial(bash(bad));
});

test('refusal never advertises the release valve', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  assert.doesNotMatch(denial(bash(commit(PLAIN))), /third/i);
});

test('a clean pass resets the denial counter', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  const bad = commit(PLAIN);
  denial(bash(bad));
  denial(bash(bad));
  assert.equal(bash(commit(CAVEMAN)), '');
  denial(bash(bad));
  denial(bash(bad));
  assert.equal(bash(bad), '');
});

test('denial counters are per sink', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  denial(bash(commit(PLAIN)));
  denial(bash(commit(PLAIN)));
  denial(bash(`gh pr comment 3 --body "${PLAIN}"`));
});

test('CAVEMAN_GATE=warn denies nothing and the breach stays in reminders until a clean pass', t => {
  const { prompt, bash, sessionFile } = fixture(t);
  prompt('/caveman');
  assert.equal(bash(commit(PLAIN), { CAVEMAN_GATE: 'warn' }), '');
  assert.ok(fs.existsSync(sessionFile('.lint')));
  const first = reminder(prompt('next'));
  assert.match(first, /Last git-commit broke caveman: .*articles: /);
  assert.match(first, /Fix from this reply on\./);
  assert.ok(first.length < 1800);
  assert.match(reminder(prompt('again')), /broke caveman/);
  assert.equal(bash(commit('fix: handler\n\n' + CAVEMAN), { CAVEMAN_GATE: 'warn' }), '');
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
  assert.doesNotMatch(reminder(prompt('after fix')), /broke caveman/);
});

test('Stop records chat feedback silently and reminders repeat it until a clean reply', t => {
  const { prompt, stop, sessionFile } = fixture(t);
  prompt('/caveman');
  assert.equal(stop(PLAIN), '');
  const record = JSON.parse(fs.readFileSync(sessionFile('.lint'), 'utf8'));
  assert.equal(record.sink, 'chat');
  assert.ok(record.violations.length > 0);
  assert.match(reminder(prompt('go on')), /Last chat broke caveman: /);
  assert.match(reminder(prompt('and again')), /Last chat broke caveman: /);
  stop(CAVEMAN);
  assert.doesNotMatch(reminder(prompt('clean now')), /broke caveman/);
});

test('a clean chat reply clears the pending record', t => {
  const { prompt, stop, sessionFile } = fixture(t);
  prompt('/caveman');
  stop(PLAIN);
  assert.ok(fs.existsSync(sessionFile('.lint')));
  assert.equal(stop(CAVEMAN), '');
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
});

test('Stop is skipped while a stop hook is already active and outside caveman', t => {
  const { prompt, stop, sessionFile } = fixture(t);
  prompt('/caveman');
  stop(PLAIN, { stop_hook_active: true });
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
  prompt('/megacave');
  stop(PLAIN);
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
});

test('markdown doc writes are flagged as feedback, scratch paths are not', t => {
  const { prompt, pre, sessionFile } = fixture(t);
  prompt('/caveman');
  const guide = path.join(docDir(t), 'guide.md');
  fs.writeFileSync(guide, '# Guide\n');
  assert.equal(pre('Write', { file_path: guide, content: '# Guide\n' + PLAIN }), '');
  assert.equal(JSON.parse(fs.readFileSync(sessionFile('.lint'), 'utf8')).sink, 'doc-file');
  fs.rmSync(sessionFile('.lint'));
  assert.equal(pre('Edit', { file_path: '/private/tmp/x/scratchpad/notes.md', new_string: PLAIN }), '');
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
  const mdx = path.join(path.dirname(guide), 'guide.mdx');
  fs.writeFileSync(mdx, 'x\n');
  assert.equal(pre('Edit', { file_path: mdx, old_string: 'x', new_string: PLAIN }), '');
  assert.equal(JSON.parse(fs.readFileSync(sessionFile('.lint'), 'utf8')).sink, 'doc-file');
});

test('fenced code, inline code, URLs, quoted errors and trailers do not count', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  const body = [
    'Fix crash on cold start. Guard null session before first read.',
    '',
    '```',
    PLAIN,
    '```',
    '',
    'Error was "' + PLAIN + '" before fix.',
    'See https://example.com/the/a/the/a/the/a/the/a/the/a/the/a for trace.',
    'Run `the a the a the a the a` to repro.',
    '',
    '> ' + PLAIN,
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  assert.equal(bash(commit(body)), '');
});

test('hard-wrapped, bulleted and labelled caveman text is not one long sentence', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  const body = [
    'Retry upload on timeout. Queue keeps order; drop only after third failure;',
    'next sync resumes where last one stopped. Backoff starts at 2 s then doubles.',
    '',
    '- **Scope:** upload path only. Store untouched; schema same; migrations none.',
    '- Tests: cold start, warm start, offline, flaky network, large batch, empty queue.',
  ].join('\n');
  assert.equal(bash(commit(body)), '');
});

test('non-English prose passes', t => {
  const { prompt, bash } = fixture(t);
  prompt('/caveman');
  const russian = 'Это изменение обновляет обработчик так, чтобы запрос обрабатывался новым промежуточным слоем, '
    + 'а пользователи больше не видели ошибку при первом открытии страницы, и команда смогла удалить старый обходной путь из кода.';
  assert.equal(bash(commit(russian)), '');
  assert.equal(bash(commit('修正: ハンドラーが新しいミドルウェアを通してリクエストを処理するように変更しました。ユーザーは最初のページ表示でエラーを見なくなります。')), '');
});

test('malformed or empty stdin exits 0 silently', t => {
  const { run } = fixture(t);
  assert.equal(run(GATE, '{not json'), '');
  assert.equal(run(GATE, ''), '');
  assert.equal(run(GATE, '[]'), '');
  assert.equal(run(GATE, '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":null}'), '');
});

test('acts on the first complete payload while the host keeps stdin open', async t => {
  const { prompt, config, dir } = fixture(t);
  prompt('/caveman');
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  delete env.CAVEMAN_GATE;
  const child = spawn(process.execPath, [GATE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stdin.write(JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: commit(PLAIN) } }));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve('hung'); }, 1500);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  assert.match(denial(stdout), /git-commit refused/);
});

// --- every written output (#gate-all-sinks) ---

const HTML_PLAIN = '<h2>Flow</h2><p>' + PLAIN + '</p><pre><code>the a an the</code></pre>';
const HTML_CAVEMAN = '<h2>Flow</h2><p>' + CAVEMAN + '</p><table><tr><td>the a the an the</td></tr></table>';

test('Confluence body {format, value} and storage bodies are linted', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  const create = 'mcp__5b89a5b1-20e0-4446-a225-98a61f1fe8d1__createConfluenceContent';
  assert.match(denial(pre(create, { title: 'X', body: { format: 'html', value: HTML_PLAIN } })), /mcp-write refused/);
  const update = 'mcp__5b89a5b1-20e0-4446-a225-98a61f1fe8d1__updateConfluenceContent';
  assert.match(denial(pre(update, { body: { storage: { value: HTML_PLAIN, representation: 'storage' } } })), /mcp-write refused/);
  assert.equal(pre(create, { title: 'X', body: { format: 'html', value: HTML_CAVEMAN } }), '');
});

test('a value outside a prose key is not prose', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  assert.equal(pre('mcp__abc__update_setting', { key: 'x', value: PLAIN }), '');
});

test('generic executeWrite and Docs batch are linted, executeRead and executeDestructive are not', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  const server = 'mcp__5b89a5b1-20e0-4446-a225-98a61f1fe8d1__';
  const inputs = { name: 'createConfluenceFooterComment', inputs: { pageId: '1', body: PLAIN } };
  assert.match(denial(pre(server + 'executeWrite', inputs)), /mcp-write refused/);
  assert.equal(pre(server + 'executeRead', inputs), '');
  assert.equal(pre(server + 'executeDestructive', inputs), '');
  const docs = 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch';
  assert.match(denial(pre(docs, { container: { create: { doc: { markdown: PLAIN } } } })), /mcp-write refused/);
});

test('wrap_up recap and ask are denied, update_plan is not', t => {
  const { prompt, pre } = fixture(t);
  prompt('/caveman');
  assert.match(denial(pre('mcp__ccd_turn__wrap_up', { recap: PLAIN })), /wrap-up refused/);
  assert.match(denial(pre('mcp__ccd_turn__wrap_up', { recap: 'Done.', ask: PLAIN })), /wrap-up refused/);
  assert.equal(pre('mcp__ccd_turn__wrap_up', { recap: CAVEMAN, ask: 'Merge now?', actions: [{ label: 'Yes, merge' }] }), '');
  assert.equal(pre('mcp__ccd_turn__update_plan', { items: [{ content: PLAIN, status: 'pending' }] }), '');
});

test('Artifact publish lints the page, asset uploads and reads are ignored', t => {
  const { prompt, pre, project } = fixture(t);
  prompt('/caveman');
  const page = path.join(project, 'report.html');
  fs.writeFileSync(page, '<html><body>' + HTML_PLAIN + '<script>const the = a;</script></body></html>');
  assert.match(denial(pre('Artifact', { file_path: page })), /artifact refused/);
  assert.equal(pre('Artifact', { action: 'read', url: 'https://claude.ai/artifact/x' }), '');
  assert.equal(pre('Artifact', { file_path: page, asset: true, url: 'https://claude.ai/artifact/x' }), '');
  fs.writeFileSync(page, '<html><body>' + HTML_CAVEMAN + '</body></html>');
  assert.equal(pre('Artifact', { file_path: page }), '');
});

test('new docs and memory files are denied, html and MultiEdit edits of existing docs get feedback', t => {
  const { prompt, pre, sessionFile } = fixture(t);
  const project = docDir(t);
  prompt('/caveman');
  assert.match(denial(pre('Write', { file_path: path.join(project, 'NEW.md'), content: PLAIN })), /doc-file refused/);
  const memory = path.join(project, 'memory', 'fact.md');
  fs.mkdirSync(path.dirname(memory));
  fs.writeFileSync(memory, 'old\n');
  assert.match(denial(pre('Edit', { file_path: memory, old_string: 'old', new_string: PLAIN })), /doc-file refused/);
  const page = path.join(project, 'page.html');
  fs.writeFileSync(page, '<p>Old.</p>\n');
  assert.equal(pre('MultiEdit', { file_path: page, edits: [{ old_string: 'Old.', new_string: HTML_PLAIN }] }), '');
  assert.equal(JSON.parse(fs.readFileSync(sessionFile('.lint'), 'utf8')).sink, 'doc-file');
});

test('a Write over an existing doc lints only the lines it adds', t => {
  const { prompt, pre, sessionFile } = fixture(t);
  const project = docDir(t);
  prompt('/caveman');
  const doc = path.join(project, 'legacy.md');
  fs.writeFileSync(doc, PLAIN + '\n');
  assert.equal(pre('Write', { file_path: doc, content: PLAIN + '\n' + CAVEMAN + '\n' }), '');
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
});

test('PostToolUse after wrap_up injects the closing-message reminder with the last breach', t => {
  const { prompt, stop, run } = fixture(t);
  prompt('/caveman');
  stop(PLAIN);
  const out = JSON.parse(run(GATE, { hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: {} }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^Closing message next: caveman\./);
  assert.match(out.hookSpecificOutput.additionalContext, /Last chat breach: /);
  assert.equal(run(GATE, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }), '');
  prompt('/megacave');
  assert.equal(run(GATE, { hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: {} }), '');
});

test('HTML is linted as rendered prose: code, tables, scripts, headings and tags do not count', async () => {
  const { lint } = await import(path.join(root, 'src/hooks/caveman-lint.js'));
  assert.deepEqual(lint(HTML_CAVEMAN).violations, []);
  assert.ok(lint(HTML_PLAIN).violations.some((v) => v.rule === 'articles'));
  assert.deepEqual(lint('Fix <sha> in body. Keep <ref> pinned.').violations, []);
  assert.deepEqual(lint('<p>Fix bug &amp; ship.</p><p>Add test.</p>').violations, []);
});

test('a single overlong sentence is flagged even under the article sample size', async () => {
  const { lint } = await import(path.join(root, 'src/hooks/caveman-lint.js'));
  const v = lint('Route every request through new middleware so users stop seeing first page open error after cold start on slow older Android phones.').violations;
  assert.deepEqual(v.map((x) => x.rule), ['long-sentence']);
});

test('plugin.json PreToolUse matcher covers every tool a sink matches', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const matcher = new RegExp('^(?:' + plugin.hooks.PreToolUse[0].matcher + ')$');
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'Artifact', 'mcp__ccd_turn__wrap_up', 'mcp__x__executeWrite']) {
    assert.ok(matcher.test(tool), tool);
  }
  assert.equal(plugin.hooks.PostToolUse[0].matcher, 'mcp__ccd_turn__wrap_up');
});

test('SKILL.md gate line names every sink the gate denies or flags', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/caveman/SKILL.md'), 'utf8');
  const gate = fs.readFileSync(GATE, 'utf8');
  const ids = [...gate.matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1]);
  const named = { 'git-commit': 'commits', 'gh-pr': 'gh PR', 'gh-issue': 'issue', 'gh-api': 'api text',
    'mcp-write': 'MCP writes', 'wrap-up': 'wrap-up recap', artifact: 'Artifact pages', 'doc-file': 'doc and memory files', chat: 'chat replies' };
  const line = skill.split('\n').find((l) => l.startsWith('Hook gate refuses'));
  assert.ok(line, 'SKILL.md has the gate line');
  for (const id of ids) {
    assert.ok(named[id], `sink ${id} needs a SKILL.md name in this test`);
    assert.ok(line.includes(named[id]) || skill.includes('Edits to existing docs and ' + named[id]), `SKILL.md names ${id}`);
  }
});

test('a home dir named temp is not a scratch path', t => {
  const { prompt, pre, sessionFile } = fixture(t);
  prompt('/caveman');
  assert.match(denial(pre('Write', { file_path: '/Users/temp/Workspace/repo/docs/NEW_GUIDE.md', content: PLAIN })), /doc-file refused/);
  assert.equal(pre('Write', { file_path: '/tmp/notes.md', content: PLAIN }), '');
  assert.equal(pre('Write', { file_path: '/Users/me/.claude/x/scratchpad/notes.md', content: PLAIN }), '');
  assert.equal(fs.existsSync(sessionFile('.lint')), false);
});
