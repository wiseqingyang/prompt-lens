const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('signed packaging fails before any build when signing credentials are absent', () => {
  const env = { ...process.env, CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' };
  const result = spawnSync(process.execPath, ['scripts/package-desktop.cjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Signed release requires CSC_LINK|qualified release target/);
  assert.doesNotMatch(result.stdout, /Packaging workspace/);
});

test('retired proxy switching refuses mutations instead of claiming to restore unknown settings', () => {
  for (const mode of ['on', 'off']) {
    const result = spawnSync('/bin/bash', ['set_proxy.sh', mode], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot restore them safely/);
  }
});

test('audit policy rejects unknown vulnerabilities, production findings and expired build risk reviews', () => {
  const { assessAudit } = require('../scripts/audit-dependencies.cjs');
  const report = { metadata: { vulnerabilities: {} }, vulnerabilities: { 'sprintf-js': { severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c' }] } } };
  assert.doesNotThrow(() => assessAudit(report, false, new Date('2026-10-12')));
  assert.throws(() => assessAudit(report, true, new Date('2026-10-12')), /Production/);
  assert.throws(() => assessAudit(report, false, new Date('2026-11-25')), /expired/);
  assert.throws(() => assessAudit({ error: {} }, false), /Invalid/);
  report.vulnerabilities['sprintf-js'].via[0].url = 'https://example.invalid/new-advisory';
  assert.throws(() => assessAudit(report, false, new Date('2026-10-12')), /Unreviewed/);
});
