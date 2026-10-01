import type { InteractionClientMsg } from '../../../shared/protocol.js';
import type { HandlerMap } from './types.js';

export const interactionHandlers = {
  'interaction.resolve': (ctx, c, msg) => {
    if (typeof msg.id !== 'string' || !Number.isSafeInteger(msg.version) || !msg.response || typeof msg.response !== 'object') return;
    ctx.warn(c, ctx.interactions.resolve(msg.id, msg.version, msg.response, { id: c.id, name: c.peer.name }));
  },
} satisfies HandlerMap<InteractionClientMsg>;
