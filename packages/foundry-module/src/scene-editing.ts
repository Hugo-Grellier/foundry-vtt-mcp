import { permissionManager } from './permissions.js';

/**
 * Scene building: create scenes, edit their embedded documents (walls, lights,
 * sounds, tokens, notes, tiles, regions, drawings) and capture the canvas so an
 * agent can check what it built.
 */

export const SCENE_DOCUMENT_TYPES = [
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Token',
  'Note',
  'Tile',
  'Region',
  'Drawing',
] as const;
type SceneDocumentType = (typeof SCENE_DOCUMENT_TYPES)[number];

const LEVEL_ID = 'defaultLevel0000';

function requireSceneWrites(): void {
  const check = permissionManager.checkWritePermission('modifyScene');
  if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);
}

function findScene(identifier?: string): any {
  const scenes = game.scenes as any;
  const scene = identifier
    ? (scenes.get(identifier) ?? scenes.getName(identifier))
    : (scenes.viewed ?? scenes.current);
  if (!scene)
    throw new Error(identifier ? `Scene not found: ${identifier}` : 'No viewed or active scene');
  return scene;
}

/** Top-left of the scene's image area: Foundry rounds the padding up to whole grid squares. */
function imageOrigin(scene: any): { x: number; y: number } {
  const { width, height, padding } = scene;
  const size = scene.grid.size;
  return {
    x: Math.ceil((padding * width) / size) * size,
    y: Math.ceil((padding * height) / size) * size,
  };
}

/** Shift x/y and wall coordinates from image space to scene space. */
function toScene(data: any, origin: { x: number; y: number }): any {
  const out = { ...data };
  if (typeof out.x === 'number') out.x += origin.x;
  if (typeof out.y === 'number') out.y += origin.y;
  if (Array.isArray(out.c) && out.c.length === 4) {
    out.c = [out.c[0] + origin.x, out.c[1] + origin.y, out.c[2] + origin.x, out.c[3] + origin.y];
  }
  return out;
}

/**
 * Source data of a document: a world or pack uuid, or a document embedded in an
 * Adventure, `<Adventure uuid>.Scene.<id>` / `.Actor.<id>` (fromUuid cannot open those).
 */
async function sourceData(uuid: string, documentName: 'Scene' | 'Actor'): Promise<any> {
  const [adventureUuid, id] = uuid.split(`.${documentName}.`);
  if (uuid.includes('.Adventure.') && id) {
    const adventure: any = await fromUuid(adventureUuid);
    const collection = documentName === 'Scene' ? adventure?.scenes : adventure?.actors;
    const data =
      collection && Array.from(collection as Iterable<any>).find((d: any) => d._id === id);
    if (!data) throw new Error(`${documentName} ${id} not found in ${adventureUuid}`);
    return typeof data.toObject === 'function' ? data.toObject() : data;
  }
  const doc: any = await fromUuid(uuid);
  if (!doc || doc.documentName !== documentName) throw new Error(`Not a ${documentName}: ${uuid}`);
  return doc;
}

// Tool names -> Foundry CONST.GRID_TYPES keys. Hex columns (flat sides top and bottom) suit hexcrawl maps.
const GRID_TYPES: Record<string, string> = {
  gridless: 'GRIDLESS',
  square: 'SQUARE',
  'hex-rows-odd': 'HEXODDR',
  'hex-rows-even': 'HEXEVENR',
  'hex-columns-odd': 'HEXODDQ',
  'hex-columns-even': 'HEXEVENQ',
};

export async function createScene(options: {
  id?: string;
  name?: string;
  image?: string;
  sourceUuid?: string;
  gridSize?: number;
  gridDistance?: number;
  gridType?: string;
  gridUnits?: string;
  padding?: number;
  darkness?: number;
  view?: boolean;
}): Promise<any> {
  requireSceneWrites();
  let data: any;
  if (options.sourceUuid) {
    const source = await sourceData(options.sourceUuid, 'Scene');
    data = typeof source.toObject === 'function' ? source.toObject() : source;
    if (options.name) data.name = options.name;
  } else if (options.image) {
    const texture: any = await (foundry as any).canvas.loadTexture(options.image);
    if (!texture) throw new Error(`Cannot load image: ${options.image}`);
    const name =
      options.name ??
      options.image
        .split('/')
        .pop()!
        .replace(/\.\w+$/, '');
    data = {
      name,
      width: texture.width,
      height: texture.height,
      padding: options.padding ?? 0.1,
      grid: {
        size: options.gridSize ?? 100,
        distance: options.gridDistance ?? 5,
        ...(options.gridType
          ? { type: (CONST as any).GRID_TYPES[GRID_TYPES[options.gridType]] }
          : {}),
        ...(options.gridUnits ? { units: options.gridUnits } : {}),
      },
      levels: [{ _id: LEVEL_ID, name, background: { src: options.image } }],
      initialLevel: LEVEL_ID,
    };
  } else {
    throw new Error('Give image or sourceUuid');
  }
  if (typeof options.darkness === 'number') {
    data.environment = { ...(data.environment ?? {}), darknessLevel: options.darkness };
  }
  if (options.id) {
    if ((game.scenes as any).get(options.id)) throw new Error(`Scene ${options.id} already exists`);
    data._id = options.id;
  }
  const keepId = !!options.id || (!!options.sourceUuid && !(game.scenes as any).get(data._id));
  const [scene] = await (Scene as any).createDocuments([data], { keepId });
  if (options.view) await scene.view();
  return summarize(scene);
}

function summarize(scene: any): any {
  return {
    sceneId: scene.id,
    name: scene.name,
    width: scene.width,
    height: scene.height,
    gridSize: scene.grid.size,
    imageOrigin: imageOrigin(scene),
    counts: Object.fromEntries(
      SCENE_DOCUMENT_TYPES.map(type => [type, scene.getEmbeddedCollection(type).size])
    ),
  };
}

/** Token data for an actor uuid; compendium and adventure actors are imported into the world once. */
async function tokenFromActor(data: any): Promise<any> {
  const { actorUuid, ...rest } = data;
  let actor: any = await sourceData(actorUuid, 'Actor');
  if (typeof actor.getTokenDocument !== 'function') {
    const actors = game.actors as any;
    actor = actors.get(actor._id) ?? (await (Actor as any).create(actor, { keepId: true }));
  } else if (actor.pack) {
    const actors = game.actors as any;
    actor =
      actors.find((a: any) => a._stats?.compendiumSource === actorUuid) ??
      (await actors.importFromCompendium(game.packs.get(actor.pack), actor.id));
  }
  const token = await actor.getTokenDocument(rest);
  return token.toObject();
}

export async function editSceneDocuments(options: {
  scene?: string;
  type: SceneDocumentType;
  action: 'list' | 'create' | 'update' | 'delete';
  documents?: any[];
  ids?: string[];
  all?: boolean;
  coordinates?: 'image' | 'scene';
}): Promise<any> {
  const scene = findScene(options.scene);
  if (!SCENE_DOCUMENT_TYPES.includes(options.type)) {
    throw new Error(`type must be one of ${SCENE_DOCUMENT_TYPES.join(', ')}`);
  }
  const collection = scene.getEmbeddedCollection(options.type);
  const origin = options.coordinates === 'scene' ? { x: 0, y: 0 } : imageOrigin(scene);

  if (options.action === 'list') {
    const back = (doc: any) => {
      const data = doc.toObject();
      delete data.flags;
      return toScene(data, { x: -origin.x, y: -origin.y });
    };
    return {
      sceneId: scene.id,
      type: options.type,
      coordinates: options.coordinates ?? 'image',
      documents: collection.map(back),
    };
  }

  requireSceneWrites();
  if (options.action === 'delete') {
    const ids = options.all ? collection.map((doc: any) => doc.id) : (options.ids ?? []);
    const deleted = await scene.deleteEmbeddedDocuments(options.type, ids);
    return { sceneId: scene.id, type: options.type, deleted: deleted.length };
  }

  const documents = options.documents ?? [];
  if (options.action === 'create') {
    const data = [];
    for (const doc of documents) {
      const placed = toScene(doc, origin);
      data.push(
        options.type === 'Token' && placed.actorUuid ? await tokenFromActor(placed) : placed
      );
    }
    const created = await scene.createEmbeddedDocuments(options.type, data);
    return { sceneId: scene.id, type: options.type, created: created.map((doc: any) => doc.id) };
  }
  if (options.action === 'update') {
    const updated = await scene.updateEmbeddedDocuments(
      options.type,
      documents.map(doc => toScene(doc, origin))
    );
    return { sceneId: scene.id, type: options.type, updated: updated.map((doc: any) => doc.id) };
  }
  throw new Error(`Unknown action: ${options.action}`);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Capture a scene. `plan` (default) draws the background and every placeable in
 * full light: walls (doors green), lights, sound radii, pins with text, tokens at
 * size (hidden ones dashed). `view` renders the canvas as the GM sees it, with
 * darkness and vision.
 */
export async function captureScene(options: {
  scene?: string;
  maxWidth?: number;
  mode?: 'plan' | 'view';
  layer?: SceneDocumentType | 'none';
}): Promise<any> {
  const scene = findScene(options.scene);
  const out =
    options.mode === 'view'
      ? await renderView(scene, options)
      : await drawPlan(scene, options.maxWidth ?? 1600);
  const dataUrl = out.canvas.toDataURL('image/webp', 0.85);
  return {
    sceneId: scene.id,
    name: scene.name,
    mimeType: 'image/webp',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    pixelsPerImagePixel: out.scale,
    note: 'The image covers the scene background only: image-space coordinate = pixel / pixelsPerImagePixel.',
  };
}

async function drawPlan(
  scene: any,
  maxWidth: number
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const origin = imageOrigin(scene);
  const scale = Math.min(1, maxWidth / scene.width);
  const out = document.createElement('canvas');
  out.width = Math.round(scene.width * scale);
  out.height = Math.round(scene.height * scale);
  const g = out.getContext('2d')!;
  const at = (x: number, y: number): [number, number] => [
    (x - origin.x) * scale,
    (y - origin.y) * scale,
  ];
  const grid = scene.grid.size;
  const level = scene.levels?.contents?.[0];
  const background = await loadImage(level?.background?.src ?? scene.background?.src ?? '');
  g.fillStyle = '#222';
  g.fillRect(0, 0, out.width, out.height);
  if (background) g.drawImage(background, 0, 0, out.width, out.height);
  for (const tile of scene.tiles) {
    const image = await loadImage(tile.texture?.src ?? '');
    if (image) g.drawImage(image, ...at(tile.x, tile.y), tile.width * scale, tile.height * scale);
  }
  g.lineWidth = Math.max(2, 3 * scale * 4);
  for (const wall of scene.walls) {
    g.strokeStyle = wall.door ? '#3f3' : '#ff0';
    g.beginPath();
    g.moveTo(...at(wall.c[0], wall.c[1]));
    g.lineTo(...at(wall.c[2], wall.c[3]));
    g.stroke();
  }
  const ring = (x: number, y: number, radius: number, color: string) => {
    g.strokeStyle = color;
    g.beginPath();
    g.arc(...at(x, y), radius * scale, 0, 2 * Math.PI);
    g.stroke();
  };
  const unit = grid / (scene.grid.distance || 5);
  for (const light of scene.lights) ring(light.x, light.y, (light.config?.dim ?? 0) * unit, '#fc6');
  for (const sound of scene.sounds) ring(sound.x, sound.y, sound.radius * unit, '#6cf');
  for (const token of scene.tokens) {
    const [x, y] = at(token.x, token.y);
    const [w, h] = [token.width * grid * scale, token.height * grid * scale];
    const image = await loadImage(token.texture?.src ?? '');
    if (image) g.drawImage(image, x, y, w, h);
    g.strokeStyle = '#f33';
    g.setLineDash(token.hidden ? [6, 4] : []);
    g.strokeRect(x, y, w, h);
    g.setLineDash([]);
  }
  g.font = `${Math.max(12, Math.round(grid * scale * 0.35))}px sans-serif`;
  for (const note of scene.notes) {
    const [x, y] = at(note.x, note.y);
    g.fillStyle = '#f3f';
    g.beginPath();
    g.arc(x, y, Math.max(5, grid * scale * 0.15), 0, 2 * Math.PI);
    g.fill();
    const label = note.text || note.page?.name || note.entry?.name || '';
    if (label) {
      g.fillStyle = '#000a';
      g.fillRect(x + 8, y - 14, g.measureText(label).width + 8, 20);
      g.fillStyle = '#fff';
      g.fillText(label, x + 12, y + 1);
    }
  }
  return { canvas: out, scale };
}

/** Render the canvas fitted to the window, as the GM sees it. */
async function renderView(
  scene: any,
  options: { maxWidth?: number; layer?: string }
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const board: any = (globalThis as any).canvas;
  if (board.scene?.id !== scene.id) {
    await scene.view();
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  const layers: Record<string, string> = {
    Wall: 'walls',
    AmbientLight: 'lighting',
    AmbientSound: 'sounds',
    Note: 'notes',
    Tile: 'tiles',
    Region: 'regions',
    Drawing: 'drawings',
    Token: 'tokens',
  };
  if (options.layer && options.layer !== 'none') board[layers[options.layer]]?.activate();
  const rect = board.dimensions.sceneRect;
  const view = board.app.view as HTMLCanvasElement;
  board.pan({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    scale: Math.min(view.clientWidth / rect.width, view.clientHeight / rect.height),
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  board.app.renderer.render(board.app.stage);

  const ratio = view.width / view.clientWidth;
  const topLeft = board.stage.worldTransform.apply({ x: rect.x, y: rect.y });
  const crop = {
    x: topLeft.x * ratio,
    y: topLeft.y * ratio,
    w: rect.width * board.stage.scale.x * ratio,
    h: rect.height * board.stage.scale.y * ratio,
  };
  const out = document.createElement('canvas');
  out.width = Math.min(options.maxWidth ?? 1600, Math.round(crop.w));
  out.height = Math.round((crop.h * out.width) / crop.w);
  out
    .getContext('2d')!
    .drawImage(view, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  return { canvas: out, scale: out.width / rect.width };
}
