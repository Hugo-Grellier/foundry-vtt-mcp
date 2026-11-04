/**
 * Bridge query handlers are registered in CONFIG.queries, which Foundry's User#query
 * exposes to every connected user. These check that a handler only runs for a GM caller
 * (or for the bridge's own direct calls, which carry no query context).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardQueryHandler } from './query-guard.js';
import { QueryHandlers } from './queries.js';

describe('guardQueryHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the handler for a direct bridge call with no query context', async () => {
    const handler = vi.fn().mockResolvedValue('ok');

    await expect(guardQueryHandler('q', handler)({ a: 1 })).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledWith({ a: 1 }, undefined);
  });

  it('runs the handler when a GM sent the query', async () => {
    const handler = vi.fn().mockResolvedValue('ok');

    await expect(
      guardQueryHandler('q', handler)({ a: 1 }, { user: { isGM: true, name: 'GM' } })
    ).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a query sent by a player, without running the handler', async () => {
    const handler = vi.fn();

    await expect(
      guardQueryHandler('q', handler)({}, { user: { isGM: false, name: 'Player' } })
    ).rejects.toThrow('Access denied');
    expect(handler).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Player'));
  });

  it('refuses a query context with no user', async () => {
    const handler = vi.fn();

    await expect(guardQueryHandler('q', handler)({}, {})).rejects.toThrow('Access denied');
    await expect(guardQueryHandler('q', handler)({}, { user: null })).rejects.toThrow(
      'Access denied'
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves the handler this binding', async () => {
    const owner = {
      value: 42,
      read(this: { value: number }) {
        return this.value;
      },
    };

    await expect(guardQueryHandler('q', owner.read.bind(owner))()).resolves.toBe(42);
  });
});

describe('QueryHandlers.registerHandlers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('CONFIG', { queries: { 'other-module.keep': () => 'untouched' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function register(): Record<string, (...args: any[]) => any> {
    const handlers = Object.create(QueryHandlers.prototype) as QueryHandlers;
    handlers.registerHandlers();
    return (globalThis as any).CONFIG.queries;
  }

  it('guards every bridge handler against non-GM callers', async () => {
    const queries = register();
    const bridgeKeys = Object.keys(queries).filter(k => k.startsWith('foundry-mcp-bridge.'));

    expect(bridgeKeys.length).toBeGreaterThanOrEqual(76);

    for (const key of bridgeKeys) {
      await expect(
        queries[key]({}, { user: { isGM: false, name: 'Player' } }),
        key
      ).rejects.toThrow('Access denied');
    }
  });

  it('still lets the bridge call a handler directly', async () => {
    const ping = vi
      .spyOn(QueryHandlers.prototype as any, 'handlePing')
      .mockResolvedValue({ pong: true });
    const queries = register();

    await expect(queries['foundry-mcp-bridge.ping']({})).resolves.toEqual({ pong: true });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('leaves other modules’ queries alone', () => {
    const queries = register();

    expect(queries['other-module.keep']()).toBe('untouched');
  });
});
