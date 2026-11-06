const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let windows = process.platform === 'win32';
let crossWindows = false;
let outDir = path.join(root, 'resources', 'bin');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--windows') {
    windows = true;
    crossWindows = true;
  } else if (args[i] === '--output-dir' && args[i + 1]) {
    outDir = path.resolve(root, args[++i]);
  } else {
    throw new Error('Usage: build-core.cjs [--windows] [--output-dir directory]');
  }
}
fs.mkdirSync(outDir, { recursive: true });
const primaryName = windows ? 'prompt-lens-core.exe' : 'prompt-lens-core';
const primaryPath = path.join(outDir, primaryName);

const result = spawnSync('go', ['build', '-trimpath', '-o', primaryPath, '.'], {
  cwd: path.join(root, 'core-go'), stdio: 'inherit',
  env: crossWindows ? { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } : process.env
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
