import { describe, expect, it, vi } from 'vitest';
import { CharacterTools } from './character.js';

function makeTools(query = vi.fn().mockResolvedValue({ id: 'ringId', name: 'Unusual Ring' })) {
  const logger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const tools = new CharacterTools({ foundryClient: { query } as any, logger });
  return { tools, query };
}

describe('manage-world-items get (#116)', () => {
  it('advertises the get action and itemIdentifier', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find((t: any) => t.name === 'manage-world-items') as any;

    expect(def.inputSchema.properties.action.enum).toContain('get');
    expect(def.inputSchema.properties.itemIdentifier).toBeDefined();
  });

  it('routes get to the getWorldItem query', async () => {
    const { tools, query } = makeTools();

    const result = await tools.handleManageWorldItems({
      action: 'get',
      itemIdentifier: 'Unusual Ring',
    });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getWorldItem', {
      itemIdentifier: 'Unusual Ring',
    });
    expect(result).toEqual({ id: 'ringId', name: 'Unusual Ring' });
  });

  it('rejects get without an identifier', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handleManageWorldItems({ action: 'get' })).rejects.toThrow();
    await expect(
      tools.handleManageWorldItems({ action: 'get', itemIdentifier: '  ' })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
