import type { PendingInteraction } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    interactions: Map<string, PendingInteraction>;
  }
  interface Topics {
    interactions: true;
  }
}

export const interactions: Slice = {
  init(s) {
    s.interactions = new Map();
  },
  on: {
    welcome(s, m) {
      s.interactions = new Map((m.interactions ?? []).map((item) => [item.id, item]));
      return ['interactions'];
    },
    'interaction.upsert'(s, m) {
      s.interactions.set(m.interaction.id, m.interaction);
      return ['interactions'];
    },
    'interaction.remove'(s, m) {
      s.interactions.delete(m.id);
      return ['interactions'];
    },
  },
};
