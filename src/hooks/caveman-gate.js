#!/usr/bin/env node
// caveman — PreToolUse + Stop lint gate
//
// Reminders alone do not hold: persisted text (commits, PR and ticket bodies)
// and chat drift back to plain prose. This hook lints what the model is about
// to send and acts on a violation:
//   deny      PreToolUse: refuse the call with the breach and the fix
//   feedback  record the breach; caveman-mode-tracker.js puts it in the next
//             turn's reminder, once
// Each sink (a kind of text leaving the session) is one row in SINKS.
//
// Active only in caveman or ultracave sessions and unless the gate setting is
// `off` (CAVEMAN_GATE / `gate`, see getGate). `warn` turns every deny into
// feedback. A sink denied twice in a row passes on the third try, so a
// stubborn false positive never deadlocks the work.
//
// Always exits 0, prints nothing on any error, and never exit code 2: a
// broken gate must not block a tool call.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_DENIALS = 2;
const MAX_FILE_BYTES = 256 * 1024;
const STOP = '#stop';

const HARNESS_SERVER = /^(?:ccd_|Claude_|visualize$|terminal$|claude-in-chrome$|scheduled-tasks$|mcp-registry$)/;
const WRITE_VERB = /^(?:create|edit|update|add|send|schedule|reply|forward|comment)/;
const PROSE_KEY = /^(?:body|comment\w*|description|text|message|content|summary|markdown)$/i;
const TMP_PATH = /(?:^|[\\/])(?:tmp|temp|scratchpad)[\\/]|^\/var\/folders\//i;

const GIT_COMMIT = /\bgit\b[^\n;&|]*?\scommit(?=\s|$)/;
const GH_PR = /\bgh\s+pr\s+(?:create|edit|comment|review)\b/;
const GH_ISSUE = /\bgh\s+issue\s+(?:create|edit|comment)\b/;
const GH_API = /\bgh\s+api\b[\s\S]*\bbody\b/;

const isBash = (tool, input) => tool === 'Bash' && !!input && typeof input.command === 'string';

function mcpParts(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  return m ? { server: m[1], tool: m[2] } : null;
}

function toolWords(tool) {
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean);
}

function isMcpWrite(tool) {
  const parts = mcpParts(tool);
  return !!parts && !HARNESS_SERVER.test(parts.server) && toolWords(parts.tool).some((w) => WRITE_VERB.test(w));
}

function isDocPath(file) {
  return typeof file === 'string' && /\.mdx?$/i.test(file) && !TMP_PATH.test(file)
    && !file.startsWith(os.tmpdir() + path.sep);
}

function unquote(value) {
  if (value[0] === '"') return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  if (value[0] === "'") return value.slice(1, -1);
  return value;
}

function readCapped(file, cwd) {
  try {
    const target = path.resolve(cwd || process.cwd(), file);
    const st = fs.statSync(target);
    if (!st.isFile()) return '';
    const fd = fs.openSync(target, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return '';
  }
}

// Heredocs whose opening line holds the sink command itself (or its
// backslash-continued head), so a script written to disk earlier in the same
// shell line is not mistaken for the message.
function heredocs(command, sinkRe) {
  const found = [];
  const start = /<<(?!<)-?[ \t]*(["']?)([A-Za-z_]\w*)\1/g;
  let m;
  while ((m = start.exec(command))) {
    const lineEnd = command.indexOf('\n', start.lastIndex);
    if (lineEnd < 0) break;
    const before = command.slice(0, m.index);
    const lineStart = Math.max(...[...before.matchAll(/(?<!\\)\n/g)].map((x) => x.index + 1), 0);
    if (!sinkRe.test(before.slice(lineStart))) continue;
    const end = new RegExp('\\n[ \\t]*' + m[2] + '[ \\t]*(?=\\n|\\)|"|\'|$)').exec(command.slice(lineEnd));
    if (!end) continue;
    found.push({ text: command.slice(lineEnd + 1, lineEnd + end.index), from: m.index, to: lineEnd + end.index + end[0].length });
    start.lastIndex = lineEnd + end.index + end[0].length;
  }
  return found;
}

const VALUE = '("(?:[^"\\\\]|\\\\[\\s\\S])*"|\'[^\']*\'|[^\\s"\'`$;&|<>()]+)';
const OPTION = new RegExp('(?:^|\\s)(?:-[A-Za-z]*m|--message|-b|--body|--title)(?:=|\\s+)' + VALUE, 'g');
const FIELD = new RegExp('(?:^|\\s)(?:-f|-F|--field|--raw-field)\\s+(?:body|title)=' + VALUE, 'g');
const FILE = new RegExp('(?:^|\\s)(?:--body-file|--file|-F)(?:=|\\s+)' + VALUE, 'g');

function prose(value, out) {
  if (value && !/\$\(|`/.test(value)) out.push(value);
}

// Message text of a Bash command: heredoc bodies, quoted values of the
// message/body/title options, `-f body=` fields and the file named by
// --body-file / -F, read relative to cwd.
function bashText(command, cwd, sinkRe) {
  const parts = [];
  const blocks = heredocs(command, sinkRe);
  let rest = command;
  for (const b of [...blocks].reverse()) rest = rest.slice(0, b.from) + ' ' + rest.slice(b.to);
  for (const b of blocks) {
    let json = null;
    try { json = JSON.parse(b.text); } catch (e) { /* plain text body */ }
    if (json && typeof json === 'object') parts.push(proseFields(json));
    else parts.push(b.text);
  }
  let m;
  for (m of rest.matchAll(OPTION)) prose(unquote(m[1]), parts);
  for (m of rest.matchAll(FIELD)) {
    const v = unquote(m[1]);
    prose(v[0] === '@' ? readCapped(v.slice(1), cwd) : v, parts);
  }
  for (m of rest.matchAll(FILE)) {
    const v = unquote(m[1]);
    if (v !== '-' && !/^\w+=/.test(v)) parts.push(readCapped(v, cwd));
  }
  return parts.filter(Boolean).join('\n\n');
}

// Every string stored under a prose-like key, at any depth.
function proseFields(node, depth) {
  const level = depth || 0;
  if (!node || typeof node !== 'object' || level > 8) return '';
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (PROSE_KEY.test(key)) out.push(value);
    } else if (value && typeof value === 'object') {
      const inner = proseFields(value, level + 1);
      if (inner) out.push(inner);
    }
  }
  return out.join('\n\n');
}

const SINKS = [
  { id: 'git-commit', action: 'deny',
    match: (tool, input) => isBash(tool, input) && GIT_COMMIT.test(input.command),
    extract: (input, cwd) => bashText(input.command, cwd, GIT_COMMIT) },
  { id: 'gh-pr', action: 'deny',
    match: (tool, input) => isBash(tool, input) && GH_PR.test(input.command),
    extract: (input, cwd) => bashText(input.command, cwd, GH_PR) },
  { id: 'gh-issue', action: 'deny',
    match: (tool, input) => isBash(tool, input) && GH_ISSUE.test(input.command),
    extract: (input, cwd) => bashText(input.command, cwd, GH_ISSUE) },
  { id: 'gh-api', action: 'deny',
    match: (tool, input) => isBash(tool, input) && GH_API.test(input.command),
    extract: (input, cwd) => bashText(input.command, cwd, /\bgh\s+api\b/) },
  { id: 'mcp-write', action: 'deny',
    match: (tool) => isMcpWrite(tool),
    extract: (input) => proseFields(input) },
  { id: 'doc-file', action: 'feedback',
    match: (tool, input) => (tool === 'Write' || tool === 'Edit') && !!input && isDocPath(input.file_path),
    extract: (input) => String(input.content != null ? input.content : input.new_string || '') },
  { id: 'chat', action: 'feedback',
    match: (tool, input) => tool === STOP && !!input && typeof input.last_assistant_message === 'string',
    extract: (input) => input.last_assistant_message },
];

function clip(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

const DENY_FIX = 'Fix: drop a/an/the, split sentences over 20 words, no ceremony words, exact errors in backticks. Retry.';
const DENY_BUDGET = 600;

function denyReason(sinkId, violations) {
  const head = 'caveman gate: ' + sinkId + ' refused.';
  const lines = [];
  let room = DENY_BUDGET - head.length - DENY_FIX.length - 2;
  for (const v of violations.slice(0, 4)) {
    const line = v.rule + ': ' + clip(v.excerpt, 110);
    if (line.length + 1 > room) break;
    lines.push(line);
    room -= line.length + 1;
  }
  return [head, ...lines, DENY_FIX].join('\n');
}

function lazyModules() {
  try {
    const cfg = require('./caveman-config');
    const { lint } = require('./caveman-lint');
    const needed = ['resolveActiveMode', 'validateSessionId', 'getGate', 'readSessionGate',
      'writeSessionGate', 'readSessionLint', 'writeSessionLint', 'clearSessionLint'];
    if (typeof lint !== 'function' || needed.some((n) => typeof cfg[n] !== 'function')) return null;
    return { cfg, lint };
  } catch (e) {
    return null;
  }
}

function handle(raw) {
  const data = JSON.parse(raw);
  const event = data.hook_event_name;
  let tool;
  let input;
  if (event === 'Stop') {
    if (data.stop_hook_active) return;
    tool = STOP;
    input = data;
  } else if (event === 'PreToolUse') {
    tool = data.tool_name;
    input = data.tool_input;
  } else {
    return;
  }

  const sink = SINKS.find((s) => s.match(tool, input));
  if (!sink) return;

  const mods = lazyModules();
  if (!mods) return;
  const { cfg, lint } = mods;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionId = cfg.validateSessionId(data.session_id);
  if (!sessionId) return;
  const mode = cfg.resolveActiveMode(claudeDir, sessionId);
  if (mode !== 'caveman' && mode !== 'ultracave') return;
  const gate = cfg.getGate(data.cwd);
  if (gate === 'off') return;

  const text = sink.extract(input, data.cwd);
  if (!text || !text.trim()) return;
  const { violations } = lint(text);
  const action = sink.action === 'deny' && gate === 'warn' ? 'feedback' : sink.action;
  const counts = cfg.readSessionGate(claudeDir, sessionId);

  if (violations.length === 0) {
    if (counts[sink.id]) {
      delete counts[sink.id];
      cfg.writeSessionGate(claudeDir, sessionId, counts);
    }
    const pending = cfg.readSessionLint(claudeDir, sessionId);
    if (pending && pending.sink === sink.id) cfg.clearSessionLint(claudeDir, sessionId);
    return;
  }

  const record = {
    sink: sink.id,
    violations: violations.slice(0, 4).map((v) => ({ rule: v.rule, excerpt: clip(v.excerpt, 160), detail: clip(v.detail, 120) })),
  };

  if (action === 'deny') {
    const denied = counts[sink.id] || 0;
    if (denied >= MAX_DENIALS) {
      delete counts[sink.id];
      cfg.writeSessionGate(claudeDir, sessionId, counts);
      cfg.writeSessionLint(claudeDir, sessionId, record);
      return;
    }
    counts[sink.id] = denied + 1;
    cfg.writeSessionGate(claudeDir, sessionId, counts);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(sink.id, violations),
      },
    }));
    return;
  }

  cfg.writeSessionLint(claudeDir, sessionId, record);
}

let input = '';
let handled = false;

function run(raw) {
  if (handled) return;
  handled = true;
  try { handle(raw); } catch (e) { /* silent: a broken gate must not block a tool call */ }
}

process.stdin.setEncoding('utf8');
const watchdog = setTimeout(() => process.exit(0), 2000);
process.stdin.on('data', (chunk) => {
  input += chunk;
  try { JSON.parse(input); } catch (e) { return; }
  clearTimeout(watchdog);
  run(input);
  process.stdin.pause();
  try { process.stdin.unref(); } catch (e) { /* already detached */ }
});
process.stdin.on('error', () => process.exit(0));
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => process.exit(0));
}
process.stdin.on('end', () => { clearTimeout(watchdog); run(input); });
