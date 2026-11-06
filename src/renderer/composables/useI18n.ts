import { ref, computed } from 'vue';
import { messages, type SupportedLocale, type LocaleMode, type LocaleSchema } from '../locales';

const STORAGE_KEY = 'promptlens_locale_preference';

// Global singleton state so all components and composables stay in sync
const localeMode = ref<LocaleMode>('auto');
const currentLocale = ref<SupportedLocale>('zh-CN');

function isNodeEnv(): boolean {
  const proc = (globalThis as any).process;
  return typeof proc !== 'undefined' && Boolean(proc?.versions?.node);
}

function detectSystemLocale(): SupportedLocale {
  if (isNodeEnv() || typeof window === 'undefined' || typeof navigator === 'undefined') {
    // Default to zh-CN in SSR/testing to preserve backwards compatibility with test assertions
    return 'zh-CN';
  }
  const lang = (navigator.language || (navigator as any).userLanguage || '').toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en-US';
}

function resolveLocale(mode: LocaleMode): SupportedLocale {
  if (mode === 'auto') {
    return detectSystemLocale();
  }
  return mode;
}

function applyLocaleToDOM(loc: SupportedLocale) {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = loc;
  }
}

// Initialize on first module load if in browser
if (!isNodeEnv() && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as LocaleMode | null;
    if (saved === 'zh-CN' || saved === 'en-US' || saved === 'auto') {
      localeMode.value = saved;
    }
  } catch {}
  currentLocale.value = resolveLocale(localeMode.value);
  applyLocaleToDOM(currentLocale.value);
}

export function useI18n() {
  const locale = computed<SupportedLocale>(() => currentLocale.value);
  const mode = computed<LocaleMode>(() => localeMode.value);

  function setLocale(newMode: LocaleMode) {
    localeMode.value = newMode;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, newMode);
      }
    } catch {}
    currentLocale.value = resolveLocale(newMode);
    applyLocaleToDOM(currentLocale.value);
  }

  function getNestedValue(obj: any, path: string): string | undefined {
    const parts = path.split('.');
    let curr = obj;
    for (const part of parts) {
      if (!curr || typeof curr !== 'object') return undefined;
      curr = curr[part];
    }
    return typeof curr === 'string' ? curr : undefined;
  }

  function t(path: string, params?: Record<string, string | number>): string {
    const activeDict = messages[currentLocale.value];
    let template = getNestedValue(activeDict, path);

    // Fallback to zh-CN if not found in active locale
    if (template === undefined && currentLocale.value !== 'zh-CN') {
      template = getNestedValue(messages['zh-CN'], path);
    }

    if (template === undefined) {
      return path;
    }

    if (!params) {
      return template;
    }

    return template.replace(/\{(\w+)\}/g, (_, key) => {
      const val = params[key];
      return val !== undefined ? String(val) : `{${key}}`;
    });
  }

  function te(path: string): boolean {
    return getNestedValue(messages[currentLocale.value], path) !== undefined ||
      getNestedValue(messages['zh-CN'], path) !== undefined;
  }

  return {
    locale,
    localeMode: mode,
    setLocale,
    t,
    te
  };
}
