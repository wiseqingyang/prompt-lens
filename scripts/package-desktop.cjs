const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSnapshot } = require('./source-snapshot.cjs');
const root = path.resolve(__dirname, '..');
const preview = process.argv.includes('--preview');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The qualified release target is macOS arm64. Other targets require their own acceptance record.');
if (!preview) {
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[key]) throw new Error(`Signed release requires ${key}`);
  }
  const version = require('../package.json').version;
  if (process.env.GITHUB_REF !== `refs/tags/v${version}`) throw new Error('Signed release requires a matching version tag');
}
// Native Electron rebuilds happen in a fresh snapshot, never in the developer's node_modules.
const stage = createSnapshot(path.join(root, '.quality', `package-${preview ? 'preview' : 'signed'}-${Date.now()}`));
const run = (file, args, env = process.env) => execFileSync(file, args, { cwd: stage, stdio: 'inherit', env });
console.log(`Packaging workspace: ${stage}`);
run('npm', ['ci', '--no-fund']);
run('npm', ['run', 'build'], { ...process.env, GOOS: 'darwin', GOARCH: 'arm64' });
run('/usr/bin/lipo', [path.join(stage, 'resources/bin/prompt-lens-core'), '-verify_arch', 'arm64']);
run('npm', ['run', 'release:metadata']);
const output = path.join(root, '.quality', preview ? 'preview-release' : 'signed-release');
if (fs.existsSync(output)) throw new Error(`Remove or archive previous generated output before packaging: ${output}`);
const args = ['node_modules/electron-builder/cli.js', '--mac', ...(preview ? ['dir'] : ['dmg', 'zip']), '--arm64', '--publish', 'never', `-c.directories.output=${output}`];
if (preview) args.push('-c.mac.identity=null', '-c.forceCodeSigning=false', '-c.mac.notarize=false');
run(process.execPath, args, preview ? { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', CSC_KEY_PASSWORD: '' } : process.env);
fs.cpSync(path.join(stage, '.quality/distribution'), path.join(output, 'metadata'), { recursive: true });
fs.writeFileSync(path.join(output, 'BUILD_STATUS.txt'), preview ? 'UNSIGNED LOCAL PREVIEW. Not a release.\n' : 'Signed/notarized build; validate Gatekeeper and installation before publishing.\n');
console.log(output);
