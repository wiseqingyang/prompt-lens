const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { sourceFiles } = require('../scripts/source-files.cjs');
const { createSnapshot } = require('../scripts/source-snapshot.cjs');
const { packageSource } = require('../scripts/package-source.cjs');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-release-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'repo');
  fs.mkdirSync(directory);
  const write = (name, data) => fs.writeFileSync(path.join(directory, name), data);
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Source Test', GIT_AUTHOR_EMAIL: 'source@example.invalid',
    GIT_COMMITTER_NAME: 'Source Test', GIT_COMMITTER_EMAIL: 'source@example.invalid'
  } }).trim();
  git(['init', '-q']);
  write('package.json', JSON.stringify({ version: '1.2.3' }));
  write('LICENSE', 'Synthetic license fixture\n');
  write('run.sh', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(directory, 'run.sh'), 0o755);
  const files = ['LICENSE', 'package.json', 'run.sh', 'source-files.json'];
  const allow = values => write('source-files.json', JSON.stringify({ files: values }));
  const commit = () => { git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic source']); };
  allow(files); commit();
  return { temporary, directory, write, git, files, allow, commit, output: path.join(temporary, 'output') };
}

test('source release round-trips committed bytes and executable mode without private untracked files or Git history', t => {
  const f = fixture(t);
  f.write('personal-notes.txt', 'private synthetic note');
  f.write('.env', 'synthetic private environment');
  packageSource({ directory: f.directory, output: f.output, ref: 'refs/tags/v1.2.3' });
  const sums = fs.readFileSync(path.join(f.output, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of sums) {
    const [expected, name] = line.split('  ');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output, name))).digest('hex');
    assert.equal(actual, expected);
  }
  const extracted = path.join(f.temporary, 'extracted'); fs.mkdirSync(extracted);
  execFileSync('tar', ['-xzf', path.join(f.output, 'PromptLens-1.2.3-source.tar.gz'), '-C', extracted]);
  const restored = path.join(extracted, 'PromptLens-1.2.3');
  assert.deepEqual(fs.readdirSync(restored).sort(), [...f.files].sort());
  for (const file of f.files) assert.deepEqual(fs.readFileSync(path.join(restored, file)), fs.readFileSync(path.join(f.directory, file)));
  assert.ok(fs.statSync(path.join(restored, 'run.sh')).mode & 0o111);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'SOURCE_MANIFEST.json')));
  assert.equal(manifest.commit, f.git(['rev-parse', 'HEAD']));
  assert.ok(!JSON.stringify(manifest).includes(f.directory));
  assert.throws(() => packageSource({ directory: f.directory, output: f.output, ref: '' }), /must not exist/);
});

test('review snapshots include allowed edits, preserve executable mode and omit unlisted notes', t => {
  const f = fixture(t);
  f.write('LICENSE', 'Reviewed working edit\n');
  f.write('personal-notes.txt', 'private');
  createSnapshot(f.output, f.directory);
  assert.equal(fs.readFileSync(path.join(f.output, 'LICENSE'), 'utf8'), 'Reviewed working edit\n');
  assert.equal(fs.existsSync(path.join(f.output, 'personal-notes.txt')), false);
  assert.equal(fs.existsSync(path.join(f.output, '.git')), false);
  assert.ok(fs.statSync(path.join(f.output, 'run.sh')).mode & 0o111);
});

test('allowlist rejects unsafe, duplicate, missing and unreviewed tracked files', async t => {
  const cases = [
    ['traversal', f => f.allow([...f.files, '../private.txt']), /Invalid source path/],
    ['duplicate', f => f.allow([...f.files, 'LICENSE']), /Duplicate/],
    ['private key', f => f.allow([...f.files, 'secret.pem']), /Private material/],
    ['missing', f => fs.unlinkSync(path.join(f.directory, 'LICENSE')), /ENOENT/],
    ['file symlink', f => { fs.unlinkSync(path.join(f.directory, 'LICENSE')); fs.symlinkSync('package.json', path.join(f.directory, 'LICENSE')); }, /Symlink/],
    ['parent symlink', f => { fs.symlinkSync(f.directory, path.join(f.directory, 'linked')); f.allow([...f.files, 'linked/LICENSE']); }, /Symlink/],
    ['unreviewed tracked', f => { f.write('notes.txt', 'private'); f.git(['add', 'notes.txt']); }, /missing from source allowlist/]
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, t => {
    const f = fixture(t); mutate(f);
    assert.throws(() => createSnapshot(f.output, f.directory), expected);
    assert.equal(fs.existsSync(f.output), false);
  });
});

test('release refuses dirty, staged, uncommitted or version-mismatched input before creating output', async t => {
  const cases = [
    ['dirty', f => f.write('LICENSE', 'edit'), /clean tracked/],
    ['staged', f => { f.write('LICENSE', 'edit'); f.git(['add', 'LICENSE']); }, /clean tracked/],
    ['uncommitted allowed file', f => { f.allow([...f.files, 'next.txt']); f.git(['add', 'source-files.json']); f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic allowlist']); f.write('next.txt', 'pending'); }, /uncommitted files/],
    ['version', () => {}, /matching version tag/]
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, t => {
    const f = fixture(t); mutate(f);
    assert.throws(() => packageSource({ directory: f.directory, output: f.output, ref: name === 'version' ? 'refs/tags/v9.0.0' : '' }), expected);
    assert.equal(fs.existsSync(f.output), false);
  });
});

test('release detects archive attributes that silently omit reviewed source', t => {
  const f = fixture(t);
  f.write('.gitattributes', 'LICENSE export-ignore\n');
  f.allow([...f.files, '.gitattributes']); f.commit();
  assert.throws(() => packageSource({ directory: f.directory, output: f.output, ref: '' }), /Archive file list differs/);
  assert.equal(fs.existsSync(f.output), false);
});
