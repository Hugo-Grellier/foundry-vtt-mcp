/**
 * The sanitizer strips any field named `key` as a possible credential. Inside
 * PF2e rule elements and ActiveEffect changes, `key` is structural: it names the
 * rule element type or the attribute an effect modifies. These check that it
 * survives there and is still stripped everywhere else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';

function sanitize(data: any): any {
  const access = Object.create(FoundryDataAccess.prototype) as any;
  return access.sanitizeData(data);
}

describe('sanitizer handling of `key`', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('game', { system: { id: 'pf2e' } });
  });

  it('keeps the rule element type in PF2e rules', () => {
    const out = sanitize({
      rules: [
        { key: 'FlatModifier', selector: 'ac', value: 1 },
        { key: 'RollOption', option: 'unusual-ring' },
      ],
    });

    expect(out.rules[0].key).toBe('FlatModifier');
    expect(out.rules[1].key).toBe('RollOption');
  });

  it('keeps the attribute path in ActiveEffect changes', () => {
    const out = sanitize([
      { name: 'Bless', changes: [{ key: 'system.bonuses.mwak.attack', mode: 2, value: '1d4' }] },
    ]);

    expect(out[0].changes[0].key).toBe('system.bonuses.mwak.attack');
  });

  it('keeps it through a full document, nested under system', () => {
    const out = sanitize({
      name: 'Ring',
      system: { rules: [{ key: 'Resistance', type: 'fire' }] },
    });

    expect(out.system.rules[0].key).toBe('Resistance');
  });

  it('still strips a key that is not inside rules or changes', () => {
    const out = sanitize({ key: 'top-level', config: { key: 'nested-secret', label: 'x' } });

    expect(out.key).toBeUndefined();
    expect(out.config.key).toBeUndefined();
    expect(out.config.label).toBe('x');
  });

  it('still strips a key directly on a rules object rather than an element of it', () => {
    const out = sanitize({ rules: { key: 'not-an-element' } });

    expect(out.rules.key).toBeUndefined();
  });

  it('still strips the other sensitive names inside rules', () => {
    const out = sanitize({ rules: [{ key: 'FlatModifier', token: 'abc', password: 'x' }] });

    expect(out.rules[0].key).toBe('FlatModifier');
    expect(out.rules[0].token).toBeUndefined();
    expect(out.rules[0].password).toBeUndefined();
  });
});
