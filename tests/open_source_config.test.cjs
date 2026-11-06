const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigManager } = require('../dist/main/config');

test('new configurations do not assume a local upstream; invalid saves preserve persisted configuration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-oss-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new ConfigManager(path.join(dir, 'config.json'), '', dir);
  assert.equal(manager.resolveEffectiveUpstream(), '');
  manager.save({ proxy: { ...manager.getConfig().proxy, upstreamMode: 'direct' } });
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const proxy of [{ listenPort: 8088 }, { listenPort: 0 }, { upstreamMode: 'unknown' },
    { upstreamMode: 'custom', customUpstream: 'file:///tmp/invalid' }, { customDomains: ['bad/path'] }]) {
    assert.throws(() => manager.save({ proxy }), /配置|代理|端口|域名/);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.equal(manager.getConfig().proxy.upstreamMode, 'direct');
  }
});
