const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function sourceFiles(directory = root) {
  const files = JSON.parse(fs.readFileSync(path.join(directory, 'source-files.json'), 'utf8')).files;
  if (!Array.isArray(files) || !files.length || !files.includes('source-files.json')) throw new Error('Invalid source allowlist');
  const seen = new Set();
  for (const name of files) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid source path');
    if (seen.has(name)) throw new Error(`Duplicate source path: ${name}`);
    seen.add(name);
    if (/(^|\/)(?:\.git|\.quality|node_modules|dist|release|tmp|\.venv)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:db|sqlite3?|pem|key|p12|pfx|crt)(?:[-.]|$)/i.test(name)) throw new Error(`Private material in source list: ${name}`);
    let current = directory;
    for (const component of name.split('/')) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink source entry: ${name}`);
    }
    if (!fs.statSync(current).isFile()) throw new Error(`Non-regular source entry: ${name}`);
  }
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of tracked) if (!seen.has(name)) throw new Error(`Tracked file missing from source allowlist: ${name}`);
  return [...files].sort();
}
if (require.main === module) console.log(`Source allowlist checked: ${sourceFiles().length} files`);
module.exports = { sourceFiles };
