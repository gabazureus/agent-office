import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PendingInteraction, WorkerInfo } from '../src/shared/protocol.js';
import { InteractionCenter } from '../src/server/interactions.js';
import { claudeInteraction } from '../src/server/providers/claude.js';
import { codexInteraction } from '../src/server/providers/codex.js';
import { openCodeInteraction } from '../src/server/providers/opencode.js';
import { interactionHandlers } from '../src/server/ws/handlers/interactions.js';

test('Claude questions and scoped permissions encode exact native hook replies', () => {
  const question = claudeInteraction('PreToolUse', { session_id: 's1', tool_use_id: 't1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Target', question: 'Which target?', options: [{ label: 'Web', description: 'Browser' }, { label: 'API' }], multiSelect: false }] } })!;
  assert.equal(question.kind, 'question');
  assert.deepEqual(question.fields?.[0].options?.map((o) => o.label), ['Web', 'API']);
  assert.deepEqual(question.respond({ optionId: 'submit', answers: { q0: ['API'] } }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: [{ header: 'Target', question: 'Which target?', options: [{ label: 'Web', description: 'Browser' }, { label: 'API' }], multiSelect: false }], answers: { 'Which target?': 'API' } } } });

  const permission = claudeInteraction('PermissionRequest', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'git push' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push' }], behavior: 'allow', destination: 'session' }] })!;
  assert.deepEqual(permission.options.map((o) => o.id), ['allow-once', 'suggestion-0', 'deny']);
  assert.deepEqual(permission.respond({ optionId: 'suggestion-0' }), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push' }], behavior: 'allow', destination: 'session' }] } } });
});

test('Codex exposes only supported approval scopes and marks its proven CLI question gap', () => {
  const permission = codexInteraction('PermissionRequest', { session_id: 's', turn_id: 'turn', tool_name: 'shell', tool_input: { command: 'npm test' } })!;
  assert.deepEqual(permission.options.map((o) => o.id), ['allow', 'deny']);
  assert.equal((permission.respond({ optionId: 'allow' }) as any).hookSpecificOutput.decision.behavior, 'allow');

  const question = codexInteraction('PreToolUse', { session_id: 's', tool_use_id: 'u', tool_name: 'request_user_input', tool_input: { questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Tests' }, { label: 'All' }] }] } })!;
  assert.equal(question.kind, 'unsupported');
  assert.deepEqual(question.options, []);
  assert.match(question.description!, /no callback contract/);
});

test('OpenCode preserves its real once/always/reject choices and question reply shape', () => {
  const permission = openCodeInteraction({ type: 'permission', sessionId: 's', requestId: 'p', permission: 'bash', patterns: ['git status *'] })!;
  assert.deepEqual(permission.options.map((o) => o.id), ['once', 'always', 'reject']);
  assert.deepEqual(permission.respond({ optionId: 'always' }), { reply: 'always' });
  const question = openCodeInteraction({ type: 'question', sessionId: 's', requestId: 'q', questions: [{ header: 'Mode', question: 'Pick one', options: [{ label: 'Fast' }, { label: 'Safe' }] }] })!;
  assert.deepEqual(question.respond({ optionId: 'submit', answers: { q0: ['Safe'] } }), { answers: [['Safe']] });
  assert.deepEqual(question.respond({ optionId: 'reject' }), { reject: true });
});

test('a structured provider request is resolved by the UI protocol message and unblocks its adapter', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-integration-'));
  const sent: PendingInteraction[] = [];
  try {
    const center = new InteractionCenter(dir, (item) => sent.push(item), () => {});
    const worker: WorkerInfo = { id: 'w', kind: 'agent', provider: 'claude', deskId: 'd', name: 'Ada', color: '#fff', status: 'needs_input', acked: false, createdBy: 'test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [] };
    const draft = claudeInteraction('PermissionRequest', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } })!;
    const answer = center.request({ worker, floorId: 'f', floorName: 'Project' }, draft);
    const item = center.state()[0];
    interactionHandlers['interaction.resolve']({ interactions: center, warn: (_c: unknown, error: string | undefined) => assert.equal(error, undefined) } as any, { id: 'browser', peer: { name: 'Grace' } } as any, { t: 'interaction.resolve', id: item.id, version: item.version, response: { optionId: 'allow-once' } });
    const providerOutput = draft.respond(await answer) as any;
    assert.equal(providerOutput.hookSpecificOutput.decision.behavior, 'allow');
    assert.ok(sent.some((entry) => entry.status === 'resolved'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
