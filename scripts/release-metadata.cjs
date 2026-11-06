const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.quality/distribution');
fs.mkdirSync(output, { recursive: true });
const lock = require('../package-lock.json');
const missing = [];
const notices = ['PromptLens third-party notices', 'Includes installed build dependencies as well as runtime dependencies.\n'];
for (const name of Object.keys(lock.packages).sort()) {
  if (!name) continue;
  const directory = path.join(root, name);
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) continue; // Optional packages for other platforms are not installed/bundled.
  const pkg = JSON.parse(fs.readFileSync(manifest));
  notices.push(`\n--- ${pkg.name}@${pkg.version} (${JSON.stringify(pkg.license || pkg.licenses || 'SEE PACKAGE LICENSE')}) ---`);
  let found = false;
  for (const entry of fs.readdirSync(directory).sort()) {
    if (/^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(entry) && fs.statSync(path.join(directory, entry)).isFile()) { notices.push(fs.readFileSync(path.join(directory, entry), 'utf8')); found = true; }
  }
  const supplement = path.join(root, 'licenses', pkg.name.replace(/[/@]/g, '_') + '.txt');
  if (!found && fs.existsSync(supplement)) { notices.push(fs.readFileSync(supplement, 'utf8')); found = true; }
  if (!found) {
    const readme = fs.readdirSync(directory).find(name => /^readme(?:\.|$)/i.test(name));
    if (readme) notices.push(fs.readFileSync(path.join(directory, readme), 'utf8'));
    missing.push({ name: pkg.name, version: pkg.version, license: pkg.license, buildOnly: lock.packages[name].dev === true, repository: pkg.repository });
  }
}
fs.writeFileSync(path.join(output, 'license-text-review.json'), JSON.stringify(missing, null, 2));
if (missing.some(item => !item.buildOnly)) throw new Error('A runtime dependency lacks a collected license text. See license-text-review.json');
if (missing.length) console.warn(`${missing.length} build-only packages have no standalone license file; README and declarations retained for maintainer review.`);
// Include every external Go module, so adding a dependency cannot silently omit its notice.
const goModules = execFileSync('go', ['list', '-m', '-f', '{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}', 'all'], { cwd: path.join(root, 'core-go'), encoding: 'utf8' })
  .split('\n').filter(Boolean).map(line => {
    const [name, version, directory] = line.split('|');
    if (!directory) throw new Error(`Go module directory unavailable: ${name}@${version}`);
    return { name, version, directory };
  });
for (const module of goModules) {
  const files = fs.readdirSync(module.directory).sort().filter(entry =>
    /^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(entry) && fs.statSync(path.join(module.directory, entry)).isFile());
  if (!files.length) throw new Error(`Go module lacks a collected license text: ${module.name}@${module.version}`);
  notices.push(`\n--- ${module.name}@${module.version} ---\n`, ...files.map(entry => fs.readFileSync(path.join(module.directory, entry), 'utf8')));
}
// Go runtime license is part of the distributed native binary too.
const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: path.join(root, 'core-go'), encoding: 'utf8' }).trim();
notices.push('\n--- Go runtime ---\n', fs.readFileSync(path.join(goroot, 'LICENSE'), 'utf8'));
fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
for (const entry of ['LICENSE', 'LICENSES.chromium.html']) {
  const source = path.join(root, 'node_modules/electron/dist', entry);
  if (!fs.existsSync(source)) throw new Error('Missing Electron runtime notice: ' + entry);
  fs.copyFileSync(source, path.join(output, 'Electron-' + entry));
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
fs.writeFileSync(path.join(output, 'npm-sbom.cdx.json'), execFileSync(npm, ['sbom', '--sbom-format=cyclonedx'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
const modules = execFileSync('go', ['list', '-m', '-f', '{{.Path}}|{{.Version}}|{{.Sum}}|{{.GoModSum}}|{{.GoVersion}}', 'all'], { cwd: path.join(root, 'core-go'), encoding: 'utf8' }).trim().split('\n').map(line => {
  const [module, version, sum, goModSum, goVersion] = line.split('|');
  return { module, version, sum, goModSum, goVersion };
});
fs.writeFileSync(path.join(output, 'go-modules.json'), JSON.stringify(modules, null, 2));
fs.writeFileSync(path.join(output, 'toolchain.json'), JSON.stringify({ node: process.version, go: execFileSync('go', ['version'], { cwd: path.join(root, 'core-go'), encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch }, null, 2));
console.log('Distribution licenses and dependency inventories written to .quality/distribution');
