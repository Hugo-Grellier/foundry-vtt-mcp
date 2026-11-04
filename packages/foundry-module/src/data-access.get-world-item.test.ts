/**
 * getWorldItem tests (#116).
 *
 * The bridge could create, list and update world-level Items but never read one
 * back: `listWorldItems` returns index fields only and `getCompendiumDocumentFull`
 * only reads packs. These cover the new read path and its identifier rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';

function makeItem(id: string, name: string, system: Record<string, any>, liveSystem?: any) {
  return {
    id,
    name,
    type: 'equipment',
    img: 'icons/ring.webp',
    folder: { id: 'folder-1', name: 'Custom Loot' },
    // The live system can hold Map-backed fields (dnd5e Activities); the read
    // must come from toObject() so those don't collapse to {}.
    system: liveSystem ?? system,
    toObject: () => ({ _id: id, name, type: 'equipment', img: 'icons/ring.webp', system }),
  };
}

function stubGame(items: any[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'user-1', name: 'GM' },
    system: { id: 'pf2e' },
    items: { get: (id: string) => byId.get(id), contents: items },
  });
}

function makeDataAccess(): FoundryDataAccess {
  return Object.create(FoundryDataAccess.prototype) as FoundryDataAccess;
}

const ringSystem = {
  description: { value: '<p>A ring of unusual make.</p>' },
  level: { value: 3 },
  traits: { value: ['magical', 'invested'], rarity: 'uncommon' },
  rules: [{ key: 'FlatModifier', selector: 'ac', value: 1 }],
};

describe('FoundryDataAccess.getWorldItem', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a world item in full by id', async () => {
    stubGame([makeItem('ringId0000000001', 'Unusual Ring', ringSystem)]);

    const result = await makeDataAccess().getWorldItem({ itemIdentifier: 'ringId0000000001' });

    expect(result).toMatchObject({
      id: 'ringId0000000001',
      name: 'Unusual Ring',
      type: 'equipment',
      img: 'icons/ring.webp',
      folderId: 'folder-1',
      folderName: 'Custom Loot',
    });
    expect(result.system.description.value).toBe('<p>A ring of unusual make.</p>');
    expect(result.system.level.value).toBe(3);
    expect(result.system.traits.value).toEqual(['magical', 'invested']);
    expect(result.system.rules).toEqual([{ key: 'FlatModifier', selector: 'ac', value: 1 }]);
    expect(result.fullData.name).toBe('Unusual Ring');
  });

  it('falls back to an exact, case-insensitive name match', async () => {
    stubGame([makeItem('ringId0000000001', 'Unusual Ring', ringSystem)]);

    const result = await makeDataAccess().getWorldItem({ itemIdentifier: '  unusual ring ' });

    expect(result.id).toBe('ringId0000000001');
  });

  it('does not partially match a name', async () => {
    stubGame([makeItem('ringId0000000001', 'Unusual Ring', ringSystem)]);

    await expect(makeDataAccess().getWorldItem({ itemIdentifier: 'Ring' })).rejects.toThrow(
      /not found/i
    );
  });

  it('refuses an ambiguous name and lists the candidate ids', async () => {
    stubGame([
      makeItem('ringId0000000001', 'Unusual Ring', ringSystem),
      makeItem('ringId0000000002', 'Unusual Ring', ringSystem),
    ]);

    await expect(makeDataAccess().getWorldItem({ itemIdentifier: 'Unusual Ring' })).rejects.toThrow(
      /ringId0000000001, ringId0000000002/
    );
  });

  it('prefers an id match over a same-named item', async () => {
    stubGame([
      makeItem('ringId0000000001', 'ringId0000000002', ringSystem),
      makeItem('ringId0000000002', 'Other Ring', { description: { value: 'other' } }),
    ]);

    const result = await makeDataAccess().getWorldItem({ itemIdentifier: 'ringId0000000002' });

    expect(result.name).toBe('Other Ring');
  });

  it('reads Map-backed fields from source rather than the live system', async () => {
    const source = {
      description: { value: 'Has an activity.' },
      activities: { act1: { type: 'utility', name: 'Glow' } },
    };
    const liveSystem = { ...source, activities: new Map([['act1', { type: 'utility' }]]) };
    stubGame([makeItem('wandId0000000001', 'Wand', source, liveSystem)]);

    const result = await makeDataAccess().getWorldItem({ itemIdentifier: 'Wand' });

    expect(result.system.activities.act1).toEqual({ type: 'utility', name: 'Glow' });
  });

  it('restores advancement, which the sanitizer otherwise strips', async () => {
    const source = { description: { value: '' }, advancement: [{ type: 'HitPoints' }] };
    stubGame([makeItem('classId000000001', 'Fighter', source)]);

    const result = await makeDataAccess().getWorldItem({ itemIdentifier: 'Fighter' });

    expect(result.system.advancement).toEqual([{ type: 'HitPoints' }]);
    expect(result.fullData.system.advancement).toEqual([{ type: 'HitPoints' }]);
  });

  it('errors on a missing identifier', async () => {
    stubGame([]);

    await expect(makeDataAccess().getWorldItem({ itemIdentifier: '   ' })).rejects.toThrow(
      /itemIdentifier is required/
    );
  });
});
