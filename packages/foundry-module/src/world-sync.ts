import { permissionManager } from './permissions.js';

/**
 * Generic world sync for an external tool that owns some documents: every document it
 * manages carries `flags.ttrpg`; this lists them and applies create/update/delete batches.
 * The caller computes the diff, so the module stays a thin, generic executor.
 */

export const SYNC_TYPES = [
  'Folder',
  'JournalEntry',
  'JournalEntryPage',
  'Actor',
  'Item',
  'ActiveEffect',
  'Note',
] as const;
type SyncType = (typeof SYNC_TYPES)[number];

/** A document reference: top-level, or embedded in `parent` (`JournalEntry.<id>`, `Actor.<id>`, `Scene.<id>`). */
interface Ref {
  documentName: SyncType;
  parent?: string;
  _id: string;
}

/**
 * `source`: a document uuid the new document is copied from (a compendium creature or item);
 * `data` then overrides its fields. `adjust`: a pf2e NPC adjustment ("elite" or "weak").
 */
interface SyncDocument extends Ref {
  data: Record<string, any>;
  source?: string;
  adjust?: string;
}

function requireWorldWrites(): void {
  const check = permissionManager.checkWritePermission('modifyWorld');
  if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);
}

function parentOf(parent: string): any {
  const [name, id] = parent.split('.');
  const doc = (game as any).collections.get(name)?.get(id);
  if (!doc) throw new Error(`Parent not found: ${parent}`);
  return doc;
}

function parentOrNull(parent: string): any {
  const [name, id] = parent.split('.');
  return (game as any).collections.get(name)?.get(id) ?? null;
}

function lookup(ref: Ref): any {
  return ref.parent
    ? parentOf(ref.parent).getEmbeddedCollection(ref.documentName).get(ref._id)
    : (game as any).collections.get(ref.documentName)?.get(ref._id);
}

function managed(doc: any): boolean {
  return !!doc?.flags?.ttrpg;
}

function describe(doc: any, parent: string | undefined, withText: boolean): any {
  const out: any = { documentName: doc.documentName, _id: doc.id, flags: doc.flags.ttrpg };
  if (parent) out.parent = parent;
  if (withText && doc.documentName === 'JournalEntryPage') out.markdown = doc.text?.markdown ?? '';
  return out;
}

/** Every managed document of the given types; page markdown when asked (for edit detection). */
export async function inventory(options: { types?: SyncType[]; text?: boolean }): Promise<any> {
  const types = new Set(options.types ?? SYNC_TYPES);
  const text = !!options.text;
  const found: any[] = [];
  const embedded = (parentName: string, collection: any, child: SyncType, field: string) => {
    if (!types.has(child)) return;
    for (const parent of collection) {
      for (const doc of parent[field]) {
        if (managed(doc)) found.push(describe(doc, `${parentName}.${parent.id}`, text));
      }
    }
  };
  for (const name of ['Folder', 'JournalEntry', 'Actor', 'Item'] as const) {
    if (!types.has(name)) continue;
    for (const doc of (game as any).collections.get(name)) {
      if (managed(doc)) found.push(describe(doc, undefined, text));
    }
  }
  embedded('JournalEntry', (game as any).journal, 'JournalEntryPage', 'pages');
  embedded('Actor', (game as any).actors, 'ActiveEffect', 'effects');
  embedded('Scene', (game as any).scenes, 'Note', 'notes');
  return { documents: found };
}

/** Ownership keys may be user names prefixed with "@" (the notes know players by name). */
function resolveOwners(data: Record<string, any>): Record<string, any> {
  if (!data.ownership) return data;
  const ownership: Record<string, number> = {};
  for (const [key, level] of Object.entries(data.ownership as Record<string, number>)) {
    if (!key.startsWith('@')) {
      ownership[key] = level;
      continue;
    }
    const user = (game as any).users.getName(key.slice(1));
    if (user) ownership[user.id] = level;
  }
  return { ...data, ownership };
}

async function prepare(item: SyncDocument): Promise<any> {
  let data: any = resolveOwners({ ...item.data, _id: item._id });
  if (item.source) {
    const source: any = await fromUuid(item.source);
    if (!source) throw new Error(`Source not found: ${item.source}`);
    const base = source.toObject();
    delete base._id;
    data = foundry.utils.mergeObject(base, data, { inplace: false });
  }
  return data;
}

function groups<T extends Ref>(items: T[]): T[][] {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.documentName}|${item.parent ?? ''}`;
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return [...out.values()];
}

async function run(
  items: Ref[],
  action: 'create' | 'update' | 'delete',
  payload: (item: any) => Promise<any>
): Promise<any[]> {
  const results: any[] = [];
  for (const batch of groups(items)) {
    const { documentName, parent } = batch[0];
    const values = await Promise.all(batch.map(payload));
    const cls: any = (CONFIG as any)[documentName].documentClass;
    const owner = parent ? parentOf(parent) : null;
    let docs: any[] = [];
    if (action === 'create')
      docs = owner
        ? await owner.createEmbeddedDocuments(documentName, values, { keepId: true })
        : await cls.createDocuments(values, { keepId: true });
    if (action === 'update')
      docs = owner
        ? await owner.updateEmbeddedDocuments(documentName, values)
        : await cls.updateDocuments(values);
    if (action === 'delete')
      docs = owner
        ? await owner.deleteEmbeddedDocuments(documentName, values)
        : await cls.deleteDocuments(values);
    results.push(...docs);
  }
  return results;
}

/**
 * Apply a batch. `create` keeps the given ids; `update` and `delete` only reach managed
 * documents; `adopt` updates documents the tool did not create (an adventure's actor), which
 * become managed through the flags it writes. Missing adopted documents are reported, not created.
 */
export async function applySync(options: {
  create?: SyncDocument[];
  update?: SyncDocument[];
  adopt?: SyncDocument[];
  delete?: Ref[];
}): Promise<any> {
  requireWorldWrites();
  for (const ref of [...(options.update ?? []), ...(options.delete ?? [])]) {
    if (!managed(lookup(ref)))
      throw new Error(`Not a managed document: ${ref.documentName} ${ref._id}`);
  }
  for (const ref of (options.create ?? []).filter(ref => !ref.parent || parentOrNull(ref.parent))) {
    if (lookup(ref)) throw new Error(`Already exists: ${ref.documentName} ${ref._id}`);
  }
  // An adventure actor the notes name may not be in this world: report it, skip what hangs on it.
  const present = (ref: Ref) => !ref.parent || !!parentOrNull(ref.parent);
  const adopt = (options.adopt ?? []).filter(ref => lookup(ref));
  const create = (options.create ?? []).filter(present);
  const missing = [
    ...(options.adopt ?? []).filter(ref => !lookup(ref)),
    ...(options.create ?? []).filter(ref => !present(ref)),
  ].map(ref =>
    ref.parent ? `${ref.parent}.${ref.documentName}.${ref._id}` : `${ref.documentName}.${ref._id}`
  );
  const created = await run(create, 'create', prepare);
  for (const item of create) {
    if (item.adjust && item.documentName === 'Actor') {
      const actor: any = (game as any).actors.get(item._id);
      if (typeof actor?.applyAdjustment === 'function') await actor.applyAdjustment(item.adjust);
    }
  }
  const updated = await run([...(options.update ?? []), ...adopt], 'update', async item =>
    resolveOwners({ ...item.data, _id: item._id })
  );
  const deleted = await run(options.delete ?? [], 'delete', async (ref: Ref) => ref._id);
  return {
    created: created.length,
    updated: updated.length,
    deleted: deleted.length,
    missing,
  };
}

/** Read a world setting (`scope.key`). */
function getSetting(key: string): any {
  const [scope, ...rest] = key.split('.');
  return (game as any).settings.get(scope, rest.join('.'));
}

/**
 * Merge entries into an object-valued world setting and remove others: for modules that keep a
 * collection in one setting (a clocks module), so the tool's entries change and the GM's stay.
 */
async function mergeSetting(options: {
  key: string;
  set?: Record<string, any>;
  remove?: string[];
}): Promise<any> {
  requireWorldWrites();
  const [scope, ...rest] = options.key.split('.');
  const name = rest.join('.');
  const config = (game as any).settings.settings.get(`${scope}.${name}`);
  if (!config) throw new Error(`Unknown setting: ${options.key}`);
  if (config.scope !== 'world') throw new Error(`Not a world setting: ${options.key}`);
  const value = foundry.utils.deepClone(getSetting(options.key) ?? {});
  for (const id of options.remove ?? []) delete value[id];
  Object.assign(value, options.set ?? {});
  await (game as any).settings.set(scope, name, value);
  return { keys: Object.keys(value).length };
}

/** World time in seconds; set it when `worldTime` is given. */
async function worldTime(options: { worldTime?: number }): Promise<any> {
  if (typeof options.worldTime === 'number') {
    requireWorldWrites();
    const time: any = (game as any).time;
    if (typeof time.set === 'function') await time.set(options.worldTime);
    else await time.advance(options.worldTime - time.worldTime);
  }
  return { worldTime: (game as any).time.worldTime };
}

/**
 * Simple Calendar's view of the world time, when that module is active: the current date and,
 * for a given date (month and day 0-based, its convention), the world time that shows it at the
 * current time of day.
 */
function calendar(options: { date?: { year: number; month: number; day: number } }): any {
  const api = (window as any).SimpleCalendar?.api;
  if (!api || !(game as any).modules.get('foundryvtt-simple-calendar-reborn')?.active) {
    return { active: false };
  }
  const now = api.timestampToDate((game as any).time.worldTime);
  const time = { hour: now.hour, minute: now.minute, seconds: now.seconds };
  const out: any = {
    active: true,
    current: { year: now.year, month: now.month, day: now.day, ...time },
  };
  if (options.date) out.timestamp = api.dateToTimestamp({ ...options.date, ...time });
  return out;
}

/** Merge entries into an object flag of a world document (`Scene.<id>`), like mergeSetting. */
async function mergeFlag(options: {
  uuid: string;
  scope: string;
  key: string;
  set?: Record<string, any>;
  remove?: string[];
}): Promise<any> {
  requireWorldWrites();
  const doc = parentOrNull(options.uuid);
  if (!doc) throw new Error(`Not found: ${options.uuid}`);
  const base = `flags.${options.scope}.${options.key}`;
  const updates: Record<string, any> = {};
  for (const id of options.remove ?? []) updates[`${base}.-=${id}`] = null;
  for (const [id, value] of Object.entries(options.set ?? {})) updates[`${base}.${id}`] = value;
  if (Object.keys(updates).length) await doc.update(updates);
  return { changed: Object.keys(updates).length };
}

/** Every map pin (Note) of a scene, managed or not: what it opens, for the tool to retarget. */
function sceneNotes(options: { uuid: string }): any {
  const scene = parentOrNull(options.uuid);
  if (!scene) return { exists: false, notes: [] };
  return {
    exists: true,
    notes: scene.notes.map((note: any) => ({
      _id: note.id,
      entryId: note.entryId ?? null,
      pageId: note.pageId ?? null,
      text: note.text ?? '',
      flags: note.flags?.ttrpg ?? null,
    })),
  };
}

export async function syncWorld(options: any): Promise<any> {
  if (options.op === 'scene-notes') return sceneNotes(options);
  if (options.op === 'calendar') return calendar(options);
  if (options.op === 'flag') {
    const doc = parentOrNull(options.uuid);
    return { value: doc?.flags?.[options.scope]?.[options.key] ?? null, exists: !!doc };
  }
  if (options.op === 'merge-flag') return mergeFlag(options);
  if (options.op === 'inventory') return inventory(options);
  if (options.op === 'apply') return applySync(options);
  if (options.op === 'setting') return { value: getSetting(options.key) ?? null };
  if (options.op === 'merge-setting') return mergeSetting(options);
  if (options.op === 'time') return worldTime(options);
  throw new Error(`Unknown op: ${options.op}`);
}
