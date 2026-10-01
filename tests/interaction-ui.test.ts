import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PendingInteraction } from '../src/shared/protocol.js';
import { interactionOrder } from '../src/client/ui/interactions.js';

const item = (id: string, createdAt: number, status: PendingInteraction['status'] = 'pending', danger = false): PendingInteraction => ({
  id, version: 1, workerId: `w-${id}`, workerName: id, floorId: 'f', floorName: 'Project', provider: 'claude', kind: 'permission', status,
  createdAt, updatedAt: createdAt, title: id, prompt: 'Decide', options: [{ id: 'yes', label: 'Yes', intent: 'approve', ...(danger ? { risk: 'danger' as const } : {}) }],
});

const unsupported = (id: string, createdAt: number): PendingInteraction => ({
  ...item(id, createdAt, 'error'),
  kind: 'unsupported',
  options: [],
  unsupportedReason: 'The provider has no structured reply callback.',
});

test('the interaction queue keeps simultaneous items separate and orders blocking risk then age', () => {
  assert.deepEqual(interactionOrder([item('old', 1), unsupported('fallback', -1), item('danger', 3, 'pending', true), item('done', 0, 'resolved'), item('new', 2)]).map((entry) => entry.id), ['danger', 'old', 'new', 'fallback', 'done']);
});

test('the dock source covers empty/count/detail, response states, keyboard and accessible announcements', () => {
  const source = readFileSync(path.join(import.meta.dirname, '../src/client/ui/interactions.ts'), 'utf8');
  for (const required of ['No pending decisions', 'interaction-badge', 'interaction-detail-scroll', "event.key !== 'Escape'", "'aria-live': 'polite'", "status === 'sending'", "status === 'error'", 'Retry', 'submitFields', "type: field.multiple ? 'checkbox' : 'radio'", "field.secret ? 'input' : 'textarea'", "field.secret ? 'password' : undefined", "message.t === 'welcome'"]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const index = readFileSync(path.join(import.meta.dirname, '../src/client/index.html'), 'utf8');
  const lite = readFileSync(path.join(import.meta.dirname, '../src/client/lite.html'), 'utf8');
  assert.match(index, /id="interaction-root"/);
  assert.match(lite, /id="interaction-root"/);
});
