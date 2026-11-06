const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const node = (id, args) => ({ id, command: process.execPath, args });

function stagesFor(fast) {
  const stages = [
    { id: 'diff-worktree', command: 'git', args: ['diff', '--check'] },
    { id: 'diff-staged', command: 'git', args: ['diff', '--cached', '--check'] },
    node('source-allowlist', ['scripts/source-files.cjs']),
    node('typecheck-main', ['node_modules/typescript/bin/tsc', '--noEmit']),
    node('typecheck-renderer', ['scripts/typecheck-renderer.cjs', '--noEmit', '-p', 'tsconfig.renderer.json']),
    { id: 'go-vet', command: 'go', args: ['vet', './...'], cwd: 'core-go' }
  ];
  if (!fast) stages.push(
    { id: 'go-race', command: 'go', args: ['test', '-race', '-count=1', './...'], cwd: 'core-go', timeoutMs: 600000 },
    node('build-main', ['node_modules/typescript/bin/tsc']),
    node('node-tests', ['scripts/test-main.cjs']),
    node('build-renderer', ['node_modules/vite/bin/vite.js', 'build']),
    node('build-core', ['scripts/build-core.cjs', '--output-dir', '.quality'])
  );
  return stages;
}

function metadata() {
  const read = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10000 });
    return result.status === 0 ? result.stdout.trim() : 'unavailable';
  };
  return {
    node: process.version,
    go: read('go', ['version'], path.join(root, 'core-go')),
    platform: process.platform,
    arch: process.arch,
    commit: read('git', ['rev-parse', 'HEAD']),
    // Only paths/status, never credentials, DB contents, or environment variables.
    worktree: read('git', ['status', '--short'])
  };
}

function runStages(stages, reportPath, options = {}) {
  const report = {
    schemaVersion: 1,
    mode: options.mode || 'full',
    startedAt: new Date().toISOString(),
    status: 'running',
    environment: options.environment || {},
    stages: stages.map(stage => ({ ...stage, status: 'pending' }))
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const save = () => {
    const temp = `${reportPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(temp, reportPath);
  };
  save(); // Replace old success before any checks start.
  for (const stage of report.stages) {
    if (report.status === 'failed') {
      stage.status = 'skipped';
      continue;
    }
    stage.status = 'running';
    save();
    console.log(`\n[verify] ${stage.id}`);
    const start = Date.now();
    const result = spawnSync(stage.command, stage.args, {
      cwd: path.resolve(options.cwd || root, stage.cwd || '.'),
      stdio: 'inherit',
      timeout: stage.timeoutMs || 300000
    });
    stage.durationMs = Date.now() - start;
    stage.exitCode = result.status;
    stage.signal = result.signal;
    stage.status = result.status === 0 && !result.error ? 'passed' : 'failed';
    if (result.error) {
      stage.errorCode = result.error.code || 'UNKNOWN';
      console.error(`[verify] ${stage.id}: ${stage.errorCode}`);
    }
    if (stage.status === 'failed') report.status = 'failed';
    save();
  }
  if (report.status !== 'failed') report.status = 'passed';
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`\n[verify] ${report.status}; report: ${reportPath}`);
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--fast')) {
    console.error('Usage: node scripts/verify.cjs [--fast]');
    process.exitCode = 1;
  } else {
    const fast = args.includes('--fast');
    const report = runStages(stagesFor(fast), path.join(root, '.quality', 'verification.json'), {
      mode: fast ? 'fast' : 'full', environment: metadata()
    });
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}

module.exports = { runStages, stagesFor };
