'use client';

import { DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop';
import { MoonIcon } from '@phosphor-icons/react/dist/csr/Moon';
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun';
import { useEffect, useState } from 'react';

import { persistThemeSetting, readThemeSetting, type ThemeSetting } from './theme-setting.ts';

type ResolvedTheme = Exclude<ThemeSetting, 'system'>;

const settings: readonly ThemeSetting[] = ['system', 'light', 'dark'];
const settingLabels: Readonly<Record<ThemeSetting, string>> = {
  system: 'Use device theme',
  light: 'Use light theme',
  dark: 'Use dark theme',
};

function applyTheme(setting: ThemeSetting): ResolvedTheme {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = setting === 'system' ? (dark ? 'dark' : 'light') : setting;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeSetting = setting;
  document.documentElement.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent('aiq-themechange', { detail: resolved }));
  return resolved;
}

export function ThemeControl() {
  const [setting, setSetting] = useState<ThemeSetting>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('light');

  useEffect(() => {
    const initial = readThemeSetting(() => window.localStorage);
    setSetting(initial);
    setResolved(applyTheme(initial));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystem = () => {
      if (document.documentElement.dataset.themeSetting === 'system') {
        setResolved(applyTheme('system'));
      }
    };
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
          title={settingLabels[candidate]}
          aria-label={settingLabels[candidate]}
          onClick={() => {
            persistThemeSetting(() => window.localStorage, candidate);
            setSetting(candidate);
            setResolved(applyTheme(candidate));
          }}
        >
          {candidate === 'system' ? (
            <DesktopIcon aria-hidden="true" size={17} />
          ) : candidate === 'light' ? (
            <SunIcon aria-hidden="true" size={17} />
          ) : (
            <MoonIcon aria-hidden="true" size={17} />
          )}
        </button>
      ))}
      <p className="sr-only" role="status" aria-label="Resolved color theme" aria-live="polite">
        Theme preference {setting}; currently {resolved}.
      </p>
    </div>
  );
}
