export type ThemeSetting = 'system' | 'light' | 'dark';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type ThemeStorageProvider = () => ThemeStorage;

const THEME_STORAGE_KEY = 'aiq-theme';

function isThemeSetting(value: string | null): value is ThemeSetting {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemeSetting(storage: ThemeStorageProvider): ThemeSetting {
  try {
    const value = storage().getItem(THEME_STORAGE_KEY);
    return isThemeSetting(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function persistThemeSetting(storage: ThemeStorageProvider, setting: ThemeSetting): boolean {
  try {
    storage().setItem(THEME_STORAGE_KEY, setting);
    return true;
  } catch {
    return false;
  }
}
