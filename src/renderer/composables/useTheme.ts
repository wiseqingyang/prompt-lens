import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'promptlens_theme_preference';

// Global singleton state so all components stay in sync
const themeMode = ref<ThemeMode>('system');
const systemIsDark = ref<boolean>(false);

function detectSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return true; // default dark fallback
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useTheme() {
  const resolvedTheme = computed<'light' | 'dark'>(() => {
    if (themeMode.value === 'system') {
      return systemIsDark.value ? 'dark' : 'light';
    }
    return themeMode.value;
  });

  const isDark = computed<boolean>(() => resolvedTheme.value === 'dark');

  function applyThemeToDOM(theme: 'light' | 'dark') {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.setAttribute('data-theme', 'light');
      root.style.colorScheme = 'light';
    }
  }

  function setTheme(mode: ThemeMode) {
    themeMode.value = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
      console.warn('Failed to save theme to localStorage:', e);
    }
    applyThemeToDOM(resolvedTheme.value);
  }

  function cycleTheme() {
    if (themeMode.value === 'system') {
      setTheme('light');
    } else if (themeMode.value === 'light') {
      setTheme('dark');
    } else {
      setTheme('system');
    }
  }

  let mediaQueryList: MediaQueryList | null = null;
  const onSystemThemeChange = (e: MediaQueryListEvent) => {
    systemIsDark.value = e.matches;
    if (themeMode.value === 'system') {
      applyThemeToDOM(systemIsDark.value ? 'dark' : 'light');
    }
  };

  function initTheme() {
    systemIsDark.value = detectSystemDark();
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (saved && (saved === 'light' || saved === 'dark' || saved === 'system')) {
        themeMode.value = saved;
      } else {
        themeMode.value = 'system';
      }
    } catch (e) {
      themeMode.value = 'system';
    }

    applyThemeToDOM(resolvedTheme.value);

    if (typeof window !== 'undefined' && window.matchMedia) {
      mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
      if (mediaQueryList.addEventListener) {
        mediaQueryList.addEventListener('change', onSystemThemeChange);
      } else {
        // Compatibility for older browsers
        mediaQueryList.addListener(onSystemThemeChange);
      }
    }
  }

  function cleanupTheme() {
    if (mediaQueryList) {
      if (mediaQueryList.removeEventListener) {
        mediaQueryList.removeEventListener('change', onSystemThemeChange);
      } else {
        mediaQueryList.removeListener(onSystemThemeChange);
      }
    }
  }

  return {
    themeMode,
    resolvedTheme,
    isDark,
    systemIsDark,
    setTheme,
    cycleTheme,
    initTheme,
    cleanupTheme
  };
}
