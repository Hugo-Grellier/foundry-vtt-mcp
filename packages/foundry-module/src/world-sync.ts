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
  'Note',
] as const;
type SyncType = (typeof SYNC_TYPES)[number];

/** A document reference: top-level, or embedded in `parent` (`JournalEntry.<id>`, `Scene.<id>`). */
interface Ref {
  documentName: SyncType;
  parent?: string;
  _id: string;
}

interface SyncDocument extends Ref {
  data: Record<string, any>;
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
  for (const name of ['Folder', 'JournalEntry', 'Actor', 'Item'] as const) {
    if (!types.has(name)) continue;
    for (const doc of (game as any).collections.get(name)) {
      if (managed(doc)) found.push(describe(doc, undefined, text));
    }
  }
  if (types.has('JournalEntryPage')) {
    for (const entry of (game as any).journal) {
      for (const page of entry.pages) {
        if (managed(page)) found.push(describe(page, `JournalEntry.${entry.id}`, text));
      }
    }
  }
  if (types.has('Note')) {
    for (const scene of (game as any).scenes) {
      for (const note of scene.notes) {
        if (managed(note)) found.push(describe(note, `Scene.${scene.id}`, text));
      }
    }
  }
  return { documents: found };
}

function groups<T extends Ref>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.documentName}|${item.parent ?? ''}`;
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}

async function run(
  items: Ref[],
  action: 'create' | 'update' | 'delete',
  payload: (item: any) => any
): Promise<number> {
  let count = 0;
  for (const batch of groups(items).values()) {
    const { documentName, parent } = batch[0];
    const values = batch.map(payload);
    const cls: any = (CONFIG as any)[documentName].documentClass;
    if (parent) {
      const owner = parentOf(parent);
      if (action === 'create')
        await owner.createEmbeddedDocuments(documentName, values, { keepId: true });
      if (action === 'update') await owner.updateEmbeddedDocuments(documentName, values);
      if (action === 'delete') await owner.deleteEmbeddedDocuments(documentName, values);
    } else {
      if (action === 'create') await cls.createDocuments(values, { keepId: true });
      if (action === 'update') await cls.updateDocuments(values);
      if (action === 'delete') await cls.deleteDocuments(values);
    }
    count += values.length;
  }
  return count;
}

/** Apply a batch. Updates and deletes only reach managed documents. */
export async function applySync(options: {
  create?: SyncDocument[];
  update?: SyncDocument[];
  delete?: Ref[];
}): Promise<any> {
  requireWorldWrites();
  const lookup = (ref: Ref): any =>
    ref.parent
      ? parentOf(ref.parent).getEmbeddedCollection(ref.documentName).get(ref._id)
      : (game as any).collections.get(ref.documentName)?.get(ref._id);
  for (const ref of [...(options.update ?? []), ...(options.delete ?? [])]) {
    if (!managed(lookup(ref)))
      throw new Error(`Not a managed document: ${ref.documentName} ${ref._id}`);
  }
  for (const ref of options.create ?? []) {
    if (lookup(ref)) throw new Error(`Already exists: ${ref.documentName} ${ref._id}`);
  }
  const data = (item: SyncDocument) => ({ ...item.data, _id: item._id });
  return {
    created: await run(options.create ?? [], 'create', data),
    updated: await run(options.update ?? [], 'update', data),
    deleted: await run(options.delete ?? [], 'delete', (ref: Ref) => ref._id),
  };
}

export async function syncWorld(options: any): Promise<any> {
  if (options.op === 'inventory') return inventory(options);
  if (options.op === 'apply') return applySync(options);
  throw new Error(`Unknown op: ${options.op}`);
}
