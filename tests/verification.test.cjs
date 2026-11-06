const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runStages } = require('../scripts/verify.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'report.json');
}
const stage = (id, script) => ({ id, command: process.execPath, args: ['-e', script] });

test('verification replaces stale success, stops at failure and records unrun stages', t => {
  const reportPath = fixture(t);
  fs.writeFileSync(reportPath, '{"status":"passed"}');
  const marker = path.join(path.dirname(reportPath), 'must-not-exist');
  const report = runStages([
    stage('ok', ''), stage('failure', 'process.exit(7)'),
    stage('unrun', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`)
  ], reportPath);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.stages.map(s => s.status), ['passed', 'failed', 'skipped']);
  assert.equal(report.stages[1].exitCode, 7);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report);
});

test('verification treats missing executable and timeout as failures', t => {
  const reportPath = fixture(t);
  const missing = runStages([{ id: 'missing', command: path.join(path.dirname(reportPath), 'missing'), args: [] }], reportPath);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.stages[0].errorCode, 'ENOENT');
  const timeout = runStages([{ ...stage('hang', 'setInterval(() => {}, 1000)'), timeoutMs: 100 }], reportPath);
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.stages[0].errorCode, 'ETIMEDOUT');
});

test('verification succeeds only when every selected stage succeeds', t => {
  const report = runStages([stage('first', ''), stage('second', '')], fixture(t));
  assert.equal(report.status, 'passed');
  assert.ok(report.finishedAt);
  assert.ok(report.stages.every(s => s.status === 'passed' && s.exitCode === 0));
});
