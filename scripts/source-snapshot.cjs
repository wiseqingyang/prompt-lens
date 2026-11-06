const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceFiles } = require('./source-files.cjs');
const root = path.resolve(__dirname, '..');

function createSnapshot(output, directory = root) {
  if (fs.existsSync(output)) throw new Error('Snapshot destination must not exist');
  const files = sourceFiles(directory);
  const manifest = [];
  for (const name of files) {
    const source = path.join(directory, name);
    const data = fs.readFileSync(source);
    const destination = path.join(output, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
    manifest.push({ path: name, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
  fs.writeFileSync(path.join(output, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return output;
}
if (require.main === module) {
  const output = path.join(root, '.quality', `public-source-${Date.now()}`);
  createSnapshot(output);
  console.log(output);
}
module.exports = { createSnapshot };
