const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
// Enumerate files ourselves: shell glob expansion differs across platforms.
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).sort();
if (!files.length) throw new Error('No Node test files found');
const result = spawnSync(process.execPath, [
  '--test', '--test-timeout=60000', ...files.map(name => join(root, 'tests', name))
], { cwd: root, stdio: 'inherit', timeout: 300000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
