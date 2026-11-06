const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { sourceFiles } = require('./source-files.cjs');
const root = path.resolve(__dirname, '..');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function packageSource({ directory = root, output = path.join(directory, '.quality/source-release'), ref = process.env.GITHUB_REF } = {}) {
  if (fs.existsSync(output)) throw new Error('Source release destination must not exist');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const files = sourceFiles(directory);
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  if (ref && ref !== `refs/tags/v${version}`) throw new Error('Source release requires a matching version tag');
  const commit = git(['rev-parse', '--verify', 'HEAD']);
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Source release requires a clean tracked worktree and index');
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
  if (JSON.stringify(files) !== JSON.stringify(tracked)) throw new Error('Source allowlist contains uncommitted files');
  const prefix = `PromptLens-${version}`;
  const archiveName = `${prefix}-source.tar.gz`;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlens-source-'));
  try {
    const archive = gzipSync(execFileSync('git', ['archive', '--format=tar', `--prefix=${prefix}/`, commit], { cwd: directory, maxBuffer: 64 * 1024 * 1024 }));
    const archivePath = path.join(temporary, archiveName);
    fs.writeFileSync(archivePath, archive);
    const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).trim().split('\n').filter(name => !name.endsWith('/')).sort();
    if (JSON.stringify(entries) !== JSON.stringify(files.map(name => `${prefix}/${name}`))) throw new Error('Archive file list differs from source allowlist');
    execFileSync('tar', ['-xzf', archivePath, '-C', temporary]);
    const manifest = { version, commit, files: files.map(name => {
      const original = fs.readFileSync(path.join(directory, name));
      const extractedPath = path.join(temporary, prefix, name);
      const data = fs.readFileSync(extractedPath);
      if (!original.equals(data)) throw new Error(`Archive content differs: ${name}`);
      const executable = Boolean(fs.statSync(path.join(directory, name)).mode & 0o111);
      if (Boolean(fs.statSync(extractedPath).mode & 0o111) !== executable) throw new Error(`Archive mode differs: ${name}`);
      return { path: name, sha256: sha256(data), executable };
    }) };
    const manifestData = JSON.stringify(manifest, null, 2) + '\n';
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, archiveName), archive);
    fs.writeFileSync(path.join(output, 'SOURCE_MANIFEST.json'), manifestData);
    fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${sha256(archive)}  ${archiveName}\n${sha256(manifestData)}  SOURCE_MANIFEST.json\n`);
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) console.log(packageSource());
module.exports = { packageSource };
