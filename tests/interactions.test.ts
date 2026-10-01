import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PendingInteraction, WorkerInfo } from '../src/shared/protocol.js';
import { InteractionCenter, interactionCorrelation, safeInteractionText } from '../src/server/interactions.js';

const worker = (id = 'w1'): WorkerInfo => ({
  id, kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Ada', color: '#fff', status: 'needs_input', acked: false,
  createdBy: 'test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], task: { name: 'Ship it', summary: '' },
});

const request = (correlationId = 'req-1') => ({
  correlationId,
  kind: 'permission' as const,
  title: 'Run command',
  prompt: 'Allow it?',
  resource: 'npm test',
  options: [
    { id: 'allow', label: 'Allow once', intent: 'approve' as const },
    { id: 'deny', label: 'Deny', intent: 'deny' as const },
  ],
});

test('redacts credentials, URL passwords and controls while keeping useful context bounded', () => {
  const text = safeInteractionText('run\u0000 Authorization: Bearer sk-live OPENAI_API_KEY=abc https://me:pw@example.com/path');
  assert.equal(text.includes('sk-live'), false);
  assert.equal(text.includes('abc'), false);
  assert.equal(text.includes(':pw@'), false);
  assert.match(text, /\[REDACTED\]/);
  assert.equal(safeInteractionText('x'.repeat(50), 12).length, 12);
  assert.equal(interactionCorrelation('w', 'codex', ['turn', 1]), interactionCorrelation('w', 'codex', ['turn', 1]));
  assert.notEqual(interactionCorrelation('w', 'codex', ['turn', 1]), interactionCorrelation('w', 'codex', ['turn', 2]));
});

test('correlates retries, separates workers and resolves exactly once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-interactions-'));
  const updates: PendingInteraction[] = [];
  try {
    const center = new InteractionCenter(dir, (item) => updates.push(item), () => {});
    const first = center.request({ worker: worker(), floorId: 'f1', floorName: 'Workspace' }, request());
    const retry = center.request({ worker: worker(), floorId: 'f1', floorName: 'Workspace' }, request());
    const other = center.request({ worker: worker('w2'), floorId: 'f2', floorName: 'Other' }, request());
    assert.equal(center.state().length, 2);
    const item = center.state().find((entry) => entry.workerId === 'w1')!;
    assert.equal(center.resolve(item.id, item.version, { optionId: 'allow' }, { id: 'c1', name: 'Grace' }), undefined);
    assert.deepEqual(await first, { optionId: 'allow' });
    assert.deepEqual(await retry, { optionId: 'allow' });
    assert.equal(center.resolve(item.id, item.version, { optionId: 'deny' }, { id: 'c2', name: 'Lin' }), undefined, 'a stale second client is idempotent');
    const otherItem = center.state().find((entry) => entry.workerId === 'w2')!;
    center.resolve(otherItem.id, otherItem.version, { optionId: 'deny' }, { id: 'c1', name: 'Grace' });
    assert.deepEqual(await other, { optionId: 'deny' });
    const audit = readFileSync(path.join(dir, 'interaction-audit.jsonl'), 'utf8');
    assert.match(audit, /"decision":"allow"/);
    assert.doesNotMatch(audit, /npm test|Allow it/);
    assert.ok(updates.some((entry) => entry.status === 'sending'));
    assert.ok(updates.some((entry) => entry.status === 'resolved'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restores active requests and rejects options the provider did not advertise', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-interactions-'));
  try {
    const one = new InteractionCenter(dir, () => {}, () => {});
    void one.request({ worker: worker(), floorId: 'f1', floorName: 'Workspace' }, request('restore-me'));
    const two = new InteractionCenter(dir, () => {}, () => {});
    const restored = two.state()[0];
    assert.equal(restored.status, 'pending');
    assert.match(two.resolve(restored.id, restored.version, { optionId: 'always' }, { id: 'c', name: 'User' })!, /not offered/);
    assert.equal(two.state()[0].status, 'error');
    const current = two.state()[0];
    two.resolve(current.id, current.version, { optionId: 'deny' }, { id: 'c', name: 'User' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(two.state()[0].status, 'denied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
