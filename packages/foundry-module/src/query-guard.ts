import { MODULE_ID } from './constants.js';

/**
 * Restrict bridge query handlers to GM callers.
 *
 * Foundry's `User#query` lets any connected user with the QUERY_USER permission
 * (players, by default) ask another user's client to run a handler registered in
 * `CONFIG.queries`, and the server relays the request whatever the handler name. The
 * receiving client calls `handler(data, { user })`, where `user` is the User who sent
 * it.
 *
 * Our handlers only checked `game.user.isGM`, which is the GM client running them, so
 * that check always passed. A player could therefore run any bridge handler with GM
 * authority from their browser console.
 *
 * The bridge's own calls (Claude, through socket-bridge, and `handleQuery`) invoke
 * handlers directly with a single argument, so they are unaffected. Anything that arrives
 * with Foundry's query context must come from a GM.
 */
export function guardQueryHandler(
  queryName: string,
  handler: (...args: any[]) => any
): (data?: unknown, context?: { user?: { isGM?: boolean; name?: string } | null }) => Promise<any> {
  return async function guardedQueryHandler(this: unknown, data, context) {
    if (context !== undefined && !context?.user?.isGM) {
      console.warn(
        `[${MODULE_ID}] Blocked "${queryName}" query from non-GM user ${context?.user?.name ?? 'unknown'}`
      );
      throw new Error('Access denied');
    }
    return handler.call(this, data, context);
  };
}
