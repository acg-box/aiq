import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { persistThemeSetting, readThemeSetting } from './theme-setting.ts';

void describe('theme setting persistence', () => {
  void it('reads only explicit supported settings', () => {
    assert.equal(
      readThemeSetting(() => ({ getItem: () => 'dark', setItem() {} })),
      'dark',
    );
    assert.equal(
      readThemeSetting(() => ({ getItem: () => 'contrast', setItem() {} })),
      'system',
    );
  });

  void it('keeps System usable when browser storage access fails', () => {
    assert.equal(
      readThemeSetting(() => {
        throw new Error('storage blocked');
      }),
      'system',
    );
  });

  void it('does not block an explicit theme change when persistence fails', () => {
    assert.equal(
      persistThemeSetting(
        () => ({
          getItem: () => null,
          setItem() {
            throw new Error('storage blocked');
          },
        }),
        'light',
      ),
      false,
    );
  });
});
