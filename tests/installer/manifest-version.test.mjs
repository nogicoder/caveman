// Every host that installs caveman shows the user a version, and reads it out
// of a different manifest. Those manifests were maintained by hand and drifted
// apart from the release (#107, #321):
//
//   .claude-plugin/plugin.json   no `version` key at all — `claude plugin list`
//                                falls back to the commit sha ("63e797cd753b"
//                                in #321) and `claude plugin update caveman`
//                                cannot resolve a version to compare against
//   gemini-extension.json        pinned at 1.0.1 — still what `gemini
//                                extensions list` reported to the reporter of
//                                #403 many releases later
//
// The release version itself already lives in two places that a test keeps
// honest: package.json `version`, and installer/install.js `PINNED_REF` (the
// immutable tag remote installs fetch from). These tests extend that guarantee
// to the manifests the hosts actually display, so a release bump can no longer
// leave a host reporting a version that has not shipped in a year.
//
// installer/install.js is deliberately not read from disk at runtime by the
// manifests — same reason as MIN_NODE_MAJOR in node-floor.test.mjs: the
// installer also runs detached from a checkout. The build is what holds them
// together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function releaseVersion() {
  const pkg = readJson('package.json');
  assert.ok(pkg.version, 'package.json declares no version');
  assert.match(pkg.version, SEMVER, `package.json version is not semver: ${pkg.version}`);
  return pkg.version;
}

// Fork (nogicoder/caveman): Claude plugin version moves alone. `claude plugin
// update` skips a commit whose manifest version is unchanged, and a full release
// bump would point install.sh, PINNED_REF and binary pins at upstream tags that
// do not exist. Upstream release pins stay on package.json.
test('.claude-plugin/plugin.json is at or ahead of the release version', () => {
  const version = readJson('.claude-plugin/plugin.json').version;
  assert.ok(version, '.claude-plugin/plugin.json declares no version (#321)');
  assert.match(version, SEMVER);
  const parts = (v) => v.split(/[-+]/)[0].split('.').map(Number);
  const [a, b] = [parts(version), parts(releaseVersion())];
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  assert.ok(cmp >= 0, `.claude-plugin/plugin.json ${version} behind package.json ${releaseVersion()}`);
});

// Manifests a host reads to tell the user which caveman they are running.
const HOST_MANIFESTS = [
  '.cursor-plugin/plugin.json',
  'gemini-extension.json',
  'plugins/caveman/.codex-plugin/plugin.json',
];

for (const rel of HOST_MANIFESTS) {
  test(`${rel} declares the release version`, () => {
    const manifest = readJson(rel);
    assert.ok(
      manifest.version,
      `${rel} declares no version — the host falls back to a commit sha (#321)`
    );
    assert.equal(
      manifest.version,
      releaseVersion(),
      `${rel} version drifted from package.json`
    );
  });
}

// PINNED_REF is what a detached (curl|bash) install downloads from, and
// installer/lib/openclaw.js stamps the workspace skill with the same number. If the
// tag and the package version disagree, the manifests above are pinned to a
// release whose files are not the ones being installed.
test('installer/install.js PINNED_REF matches the release version', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'installer', 'install.js'), 'utf8');
  const m = /const PINNED_REF = process\.env\.CAVEMAN_REF \|\| '([^']+)';/.exec(src);
  assert.ok(m, 'PINNED_REF not found in installer/install.js');
  assert.equal(
    m[1].replace(/^v/, ''),
    releaseVersion(),
    `installer/install.js PINNED_REF (${m[1]}) drifted from package.json version`
  );
});
