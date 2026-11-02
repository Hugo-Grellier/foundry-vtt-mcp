import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

const TYPES = [
  'Folder',
  'JournalEntry',
  'JournalEntryPage',
  'Actor',
  'Item',
  'ActiveEffect',
  'Note',
] as const;

const ref = z.object({
  documentName: z.enum(TYPES),
  parent: z.string().optional(),
  _id: z.string().regex(/^[A-Za-z0-9]{16}$/),
});
const doc = ref.extend({
  data: z.record(z.any()),
  source: z.string().optional(),
  adjust: z.enum(['elite', 'weak']).optional(),
});

/** Generic sync of documents an external tool owns (flags.ttrpg): list them, apply a batch. */
export class WorldSyncTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: { foundryClient: FoundryClient; logger: Logger }) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WorldSyncTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'sync-world',
        description:
          'Low-level sync of world documents owned by the TTRPG campaign tools (they carry flags.ttrpg). op "inventory" lists them (types filter; text: true adds page markdown). op "apply" creates (keeping the given _id, optionally copied from a source uuid), updates, adopts (updates a document the tool did not create, e.g. an adventure actor) and deletes batches; updates and deletes only reach managed documents. op "setting" reads a world setting (key scope.name); "merge-setting" sets and removes entries of an object-valued world setting; "time" reads or sets the world time in seconds; "calendar" converts a date with Simple Calendar when active; "flag" / "merge-flag" read and merge an object flag of a world document (uuid Scene.<id>). Normally driven by `ttrpg foundry apply`, not by hand.',
        inputSchema: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['inventory', 'apply', 'setting', 'merge-setting', 'time'],
            },
            key: { type: 'string' },
            set: { type: 'object' },
            remove: { type: 'array', items: { type: 'string' } },
            worldTime: { type: 'number' },
            types: { type: 'array', items: { type: 'string', enum: [...TYPES] } },
            text: { type: 'boolean' },
            create: { type: 'array', items: { type: 'object' } },
            update: { type: 'array', items: { type: 'object' } },
            adopt: { type: 'array', items: { type: 'object' } },
            delete: { type: 'array', items: { type: 'object' } },
          },
          required: ['op'],
        },
      },
    ];
  }

  async handleSyncWorld(args: any): Promise<any> {
    const parsed = z
      .object({
        op: z.enum([
          'inventory',
          'apply',
          'setting',
          'merge-setting',
          'time',
          'calendar',
          'flag',
          'merge-flag',
        ]),
        date: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
        uuid: z.string().optional(),
        scope: z.string().optional(),
        key: z.string().optional(),
        set: z.record(z.any()).optional(),
        remove: z.array(z.string()).optional(),
        worldTime: z.number().optional(),
        types: z.array(z.enum(TYPES)).optional(),
        text: z.boolean().optional(),
        create: z.array(doc).optional(),
        update: z.array(doc).optional(),
        adopt: z.array(doc).optional(),
        delete: z.array(ref).optional(),
      })
      .parse(args);
    this.logger.info('Syncing world', {
      op: parsed.op,
      create: parsed.create?.length,
      update: parsed.update?.length,
      delete: parsed.delete?.length,
    });
    return this.foundryClient.query('foundry-mcp-bridge.sync-world', parsed);
  }
}
