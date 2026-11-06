const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('i18n: dictionary parity between zh-CN and en-US', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: 'custom'
  });

  try {
    const { zhCN } = await server.ssrLoadModule('/src/renderer/locales/zh-CN.ts');
    const { enUS } = await server.ssrLoadModule('/src/renderer/locales/en-US.ts');

    function collectKeys(obj, prefix = '') {
      const keys = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          keys.push(...collectKeys(value, fullKey));
        } else {
          keys.push(fullKey);
        }
      }
      return keys.sort();
    }

    const zhKeys = collectKeys(zhCN);
    const enKeys = collectKeys(enUS);

    assert.deepEqual(zhKeys, enKeys, 'All keys in zh-CN and en-US dictionaries must match 100%');
  } finally {
    await server.close();
  }
});

test('i18n: useI18n composable functions and defaults in SSR/Node', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: 'custom'
  });

  try {
    const { useI18n } = await server.ssrLoadModule('/src/renderer/composables/useI18n.ts');
    const { t, locale, localeMode, setLocale } = useI18n();

    // In SSR without window, default locale must be zh-CN
    assert.equal(locale.value, 'zh-CN');

    // Basic lookup
    assert.equal(t('common.copy'), '复制');
    assert.equal(t('settings.title'), '设置');

    // Variable interpolation
    assert.equal(t('agent.sessionsCount', { count: 5 }), '5 个会话');
    assert.equal(t('detailHeader.bloatMultiplier', { n: 3.5 }), '本次请求上下文膨胀 3.5 倍');

    // Locale switching
    setLocale('en-US');
    assert.equal(locale.value, 'en-US');
    assert.equal(t('common.copy'), 'Copy');
    assert.equal(t('settings.title'), 'Settings');
    assert.equal(t('agent.sessionsCount', { count: 5 }), '5 sessions');
    assert.equal(t('detailHeader.bloatMultiplier', { n: 3.5 }), 'Prompt context bloat: 3.5x');

    // Fallback to zh-CN if key does not exist in English (or return key path if nowhere)
    assert.equal(t('nonexistent.path.test'), 'nonexistent.path.test');

    // Reset back to zh-CN
    setLocale('zh-CN');
    assert.equal(locale.value, 'zh-CN');
    assert.equal(t('common.copy'), '复制');
  } finally {
    await server.close();
  }
});

test('i18n: LocaleDropdown renders with language options', async () => {
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [vue()],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: 'custom'
  });

  try {
    const { createSSRApp } = require('vue');
    const { renderToString } = require('@vue/server-renderer');
    const { default: LocaleDropdown } = await server.ssrLoadModule('/src/renderer/components/common/LocaleDropdown.vue');

    const html = await renderToString(createSSRApp(LocaleDropdown));
    assert.match(html, /fa-language/);
    assert.match(html, /<button/);
  } finally {
    await server.close();
  }
});
