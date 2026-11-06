const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const reviewed = new Set([
  'minimatch',
  '@electron/universal',
  'electron-builder-squirrel-windows',
  'app-builder-lib',
  'electron-builder',
  'dmg-builder',
  'sprintf-js',
  'roarr',
  'global-agent',
  '@electron/get'
]);
const reviewedAdvisories = new Set([
  'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  'https://github.com/advisories/GHSA-hp3w-g68c-fv3c'
]);

function assessAudit(report, production, now = new Date()) {
  if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) throw new Error('Invalid or failed npm audit response');
  const entries = Object.entries(report.vulnerabilities);
  if (production && entries.length) throw new Error('Production dependencies contain a known vulnerability');
  if (!entries.length) return;
  if (now >= new Date('2026-11-25T00:00:00Z')) throw new Error('Build dependency risk review expired; renew the assessment or upgrade');
  for (const [name, value] of entries) {
    if (!reviewed.has(name) || !['low', 'moderate'].includes(value.severity) || !value.via?.length ||
      value.via.some(v => typeof v === 'string' ? !reviewed.has(v) : !reviewedAdvisories.has(v.url))) {
      throw new Error(`Unreviewed advisory or severity: ${name}`);
    }
  }
}
function run() {
  fs.mkdirSync(path.join(root, '.quality'), { recursive: true });
  for (const production of [true, false]) {
    const result = spawnSync('npm', ['audit', '--json', ...(production ? ['--omit=dev'] : [])], { cwd: root, encoding: 'utf8', timeout: 120000 });
    if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit failed to run');
    const report = JSON.parse(result.stdout);
    fs.writeFileSync(path.join(root, '.quality', production ? 'audit-production.json' : 'audit-all.json'), JSON.stringify(report, null, 2));
    assessAudit(report, production);
    console.log(`${production ? 'Production' : 'Full tree'} audit: ${JSON.stringify(report.metadata.vulnerabilities)}`);
  }
  const go = spawnSync('go', ['run', 'golang.org/x/vuln/cmd/govulncheck@v1.9.0', './...'], { cwd: path.join(root, 'core-go'), stdio: 'inherit', timeout: 300000 });
  if (go.error || go.status !== 0) throw new Error('Go vulnerability check failed');
}
if (require.main === module) run();
module.exports = { assessAudit };
