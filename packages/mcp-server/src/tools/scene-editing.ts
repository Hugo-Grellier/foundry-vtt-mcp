import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface SceneEditingToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const DOCUMENT_TYPES = [
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Token',
  'Note',
  'Tile',
  'Region',
  'Drawing',
] as const;

const COORDINATES =
  'Coordinates are in image pixels by default (0,0 = top-left of the scene background), so positions read off the map image need no padding math. Pass coordinates: "scene" for raw Foundry scene coordinates.';

/** An image result the backend returns as MCP image content. */
export interface ImageResult {
  __image: { data: string; mimeType: string };
  [key: string]: unknown;
}

export class SceneEditingTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SceneEditingToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SceneEditingTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'create-scene',
        description:
          'Create a scene in the world, either from a background image path (size read from the image) or by copying a scene from a compendium (a Scene uuid, or "<Adventure uuid>.Scene.<id>" for a scene inside an Adventure, keeping its walls, lights, sounds, tokens and notes).',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Scene name (defaults to the image or source name)',
            },
            image: {
              type: 'string',
              description: 'Background image path, e.g. modules/x/maps/lair.webp',
            },
            sourceUuid: {
              type: 'string',
              description: 'Compendium scene to copy instead of an image',
            },
            gridSize: {
              type: 'number',
              description: 'Pixels per grid square for an image scene (default 100)',
            },
            gridDistance: { type: 'number', description: 'Distance per square (default 5)' },
            gridType: {
              type: 'string',
              enum: [
                'square',
                'gridless',
                'hex-rows-odd',
                'hex-rows-even',
                'hex-columns-odd',
                'hex-columns-even',
              ],
              description:
                'Grid type (default square). For a hex grid, gridSize is the hex height in pixels for columns (width for rows): corner to corner is gridSize x 2/sqrt(3)',
            },
            gridUnits: {
              type: 'string',
              description: "Distance units, e.g. ft or mi (default the system's)",
            },
            padding: {
              type: 'number',
              description: 'Padding ratio around the image (default 0.1)',
            },
            darkness: { type: 'number', description: 'Darkness level 0-1' },
            view: {
              type: 'boolean',
              description: 'Show the scene to the GM afterwards (not to players)',
            },
          },
        },
      },
      {
        name: 'scene-documents',
        description: `List, create, update or delete the placeable documents of a scene: walls (c: [x1,y1,x2,y2], door 0/1/2, move, sight), ambient lights (x, y, config {dim, bright, color, alpha}), ambient sounds (x, y, radius, path, volume, darkness {min,max}), tokens (x, y and actorUuid to place any world, compendium or "<Adventure uuid>.Actor.<id>" actor, or raw token data), notes (x, y, entryId, pageId, text), tiles, regions and drawings. Data follows the Foundry document schema. ${COORDINATES}`,
        inputSchema: {
          type: 'object',
          properties: {
            scene: {
              type: 'string',
              description: 'Scene id or name (defaults to the scene the GM is viewing)',
            },
            type: { type: 'string', enum: [...DOCUMENT_TYPES] },
            action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
            documents: {
              type: 'array',
              items: { type: 'object' },
              description: 'Document data for create, or partial data with _id for update',
            },
            ids: { type: 'array', items: { type: 'string' }, description: 'Ids to delete' },
            all: {
              type: 'boolean',
              description: 'With delete: remove every document of this type',
            },
            coordinates: { type: 'string', enum: ['image', 'scene'], default: 'image' },
          },
          required: ['type', 'action'],
        },
      },
      {
        name: 'capture-scene',
        description:
          'Return an image of a scene to check placement visually. mode "plan" (default) draws the background in full light with walls (doors green), light and sound radii, pins with their text and tokens at size (hidden ones dashed). mode "view" renders the canvas as the GM sees it, with darkness and vision; layer then shows one editing layer.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: {
              type: 'string',
              description: 'Scene id or name (defaults to the viewed scene)',
            },
            maxWidth: { type: 'number', description: 'Image width in pixels (default 1600)' },
            mode: { type: 'string', enum: ['plan', 'view'], default: 'plan' },
            layer: { type: 'string', enum: [...DOCUMENT_TYPES, 'none'] },
          },
        },
      },
    ];
  }

  async handleCreateScene(args: any): Promise<any> {
    const parsed = z
      .object({
        id: z
          .string()
          .regex(/^[A-Za-z0-9]{16}$/)
          .optional(),
        name: z.string().optional(),
        image: z.string().optional(),
        sourceUuid: z.string().optional(),
        gridSize: z.number().positive().optional(),
        gridDistance: z.number().positive().optional(),
        gridType: z
          .enum([
            'square',
            'gridless',
            'hex-rows-odd',
            'hex-rows-even',
            'hex-columns-odd',
            'hex-columns-even',
          ])
          .optional(),
        gridUnits: z.string().optional(),
        padding: z.number().min(0).max(0.5).optional(),
        darkness: z.number().min(0).max(1).optional(),
        view: z.boolean().optional(),
      })
      .refine(value => value.image || value.sourceUuid, 'Give image or sourceUuid')
      .parse(args);
    this.logger.info('Creating scene', {
      name: parsed.name,
      source: parsed.sourceUuid ?? parsed.image,
    });
    return this.foundryClient.query('foundry-mcp-bridge.create-scene', parsed);
  }

  async handleSceneDocuments(args: any): Promise<any> {
    const parsed = z
      .object({
        scene: z.string().optional(),
        type: z.enum(DOCUMENT_TYPES),
        action: z.enum(['list', 'create', 'update', 'delete']),
        documents: z.array(z.record(z.any())).optional(),
        ids: z.array(z.string()).optional(),
        all: z.boolean().optional(),
        coordinates: z.enum(['image', 'scene']).optional(),
      })
      .parse(args);
    this.logger.info('Editing scene documents', {
      scene: parsed.scene,
      type: parsed.type,
      action: parsed.action,
      count: parsed.documents?.length ?? parsed.ids?.length,
    });
    return this.foundryClient.query('foundry-mcp-bridge.scene-documents', parsed);
  }

  async handleCaptureScene(args: any): Promise<ImageResult> {
    const parsed = z
      .object({
        scene: z.string().optional(),
        maxWidth: z.number().int().min(200).max(4000).optional(),
        mode: z.enum(['plan', 'view']).optional(),
        layer: z.enum([...DOCUMENT_TYPES, 'none']).optional(),
      })
      .parse(args);
    const { data, mimeType, ...rest } = await this.foundryClient.query(
      'foundry-mcp-bridge.capture-scene',
      parsed
    );
    if (!data) throw new Error(rest.error ?? 'Capture failed');
    return { ...rest, __image: { data, mimeType } };
  }
}
