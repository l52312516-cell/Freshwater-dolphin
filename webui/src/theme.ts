import { reactive, readonly } from 'vue';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ThemeAccent = 'tide' | 'moon' | 'nebula' | 'abyss';
export type ThemeContrast = 'soft' | 'oled';
export type ResolvedTheme = 'dark' | 'light';

interface ThemeState {
  mode: ThemeMode;
  accent: ThemeAccent;
  contrast: ThemeContrast;
  resolved: ResolvedTheme;
}

const KEYS = {
  mode: 'freshwater:theme-mode',
  accent: 'freshwater:theme-accent',
  contrast: 'freshwater:theme-contrast',
} as const;

const MODES: ThemeMode[] = ['dark', 'light', 'system'];
const ACCENTS: ThemeAccent[] = ['tide', 'moon', 'nebula', 'abyss'];
const CONTRASTS: ThemeContrast[] = ['soft', 'oled'];

const THEME_COLOR: Record<ResolvedTheme, string> = { dark: '#04081f', light: '#eef1f9' };

const state = reactive<ThemeState>({ mode: 'dark', accent: 'tide', contrast: 'soft', resolved: 'dark' });

let media: MediaQueryList | undefined;
let started = false;

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode or disabled storage: keep the choice for this session only. */
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  try {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply() {
  const root = document.documentElement;
  state.resolved = resolveTheme(state.mode);
  root.dataset.theme = state.resolved;
  root.dataset.accent = state.accent;
  root.dataset.contrast = state.contrast;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[state.resolved]);
}

/** 在 createApp 之前调用，避免首帧闪现错误的主题。 */
export function initTheme() {
  if (started) return;
  started = true;
  state.mode = read(KEYS.mode, MODES, 'dark');
  state.accent = read(KEYS.accent, ACCENTS, 'tide');
  state.contrast = read(KEYS.contrast, CONTRASTS, 'soft');
  apply();
  try {
    media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', () => {
      if (state.mode === 'system') apply();
    });
  } catch {
    /* Older engines without matchMedia still keep the explicit choice. */
  }
}

export function setMode(mode: ThemeMode) {
  state.mode = mode;
  write(KEYS.mode, mode);
  apply();
}

export function setAccent(accent: ThemeAccent) {
  state.accent = accent;
  write(KEYS.accent, accent);
  apply();
}

export function setContrast(contrast: ThemeContrast) {
  state.contrast = contrast;
  write(KEYS.contrast, contrast);
  apply();
}

/** 顶栏单键切换：深色 ↔ 浅色（从跟随系统进入时落定为当前解析结果）。 */
export function toggleTheme() {
  setMode(state.resolved === 'light' ? 'dark' : 'light');
}

export function useTheme() {
  return {
    theme: readonly(state),
    modes: MODES,
    accents: ACCENTS,
    contrasts: CONTRASTS,
    setMode,
    setAccent,
    setContrast,
    toggleTheme,
  };
}
