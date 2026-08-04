'use client';

import { useEffect, useState } from 'react';

type ThemeSetting = 'system' | 'light' | 'dark';

const settings: readonly ThemeSetting[] = ['system', 'light', 'dark'];

function isThemeSetting(value: string | null): value is ThemeSetting {
  return value === 'system' || value === 'light' || value === 'dark';
}

function applyTheme(setting: ThemeSetting) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = setting === 'system' ? (dark ? 'dark' : 'light') : setting;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeSetting = setting;
  document.documentElement.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent('aiq-themechange', { detail: resolved }));
}

export function ThemeControl() {
  const [setting, setSetting] = useState<ThemeSetting>('system');

  useEffect(() => {
    const stored = window.localStorage.getItem('aiq-theme');
    const initial = isThemeSetting(stored) ? stored : 'system';
    setSetting(initial);
    applyTheme(initial);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystem = () =>
      document.documentElement.dataset.themeSetting === 'system' && applyTheme('system');
    media.addEventListener('change', updateSystem);
    return () => media.removeEventListener('change', updateSystem);
  }, []);

  return (
    <div className="theme-control" role="group" aria-label="Color theme">
      {settings.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={setting === candidate}
          title={`${candidate[0]?.toUpperCase()}${candidate.slice(1)} theme`}
          onClick={() => {
            window.localStorage.setItem('aiq-theme', candidate);
            setSetting(candidate);
            applyTheme(candidate);
          }}
        >
          {candidate === 'system' ? 'System' : candidate === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}
