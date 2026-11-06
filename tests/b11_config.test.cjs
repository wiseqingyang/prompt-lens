const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ConfigManager, DEFAULT_CONFIG } = require('../dist/main/config');

test('ConfigManager loads defaults when file does not exist and saves custom config properly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-cfg-test-'));
  const testCfgPath = path.join(tmpDir, 'config.json');

  const mgr = new ConfigManager(testCfgPath, '', tmpDir);
  const initial = mgr.getConfig();
  assert.strictEqual(initial.proxy.listenPort, 8899);
  assert.strictEqual(initial.proxy.upstreamMode, 'system');
  assert.ok(Array.isArray(initial.proxy.customDomains));

  // Save new config
  const saved = mgr.save({
    proxy: {
      listenPort: 9999,
      upstreamMode: 'custom',
      customUpstream: 'http://127.0.0.1:1080',
      customDomains: ['api.siliconflow.cn', 'my-domain.com']
    },
    privacy: {
      maskApiKeys: false
    }
  });

  assert.strictEqual(saved.proxy.listenPort, 9999);
  assert.strictEqual(saved.proxy.upstreamMode, 'custom');
  assert.strictEqual(saved.privacy.maskApiKeys, false);
  assert.strictEqual(mgr.resolveEffectiveUpstream(), 'http://127.0.0.1:1080');

  // Test direct mode
  mgr.save({ proxy: { ...saved.proxy, upstreamMode: 'direct' } });
  assert.strictEqual(mgr.resolveEffectiveUpstream(), '');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
