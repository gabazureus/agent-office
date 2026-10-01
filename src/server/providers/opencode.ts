// OpenCode: a plugin the office writes (see ../opencode.ts), loaded through OPENCODE_CONFIG_CONTENT,
// reports statuses and usage snapshots on /hooks/opencode.
import { toolAction } from '../../shared/actions.js';
import { openCodeMcp } from '../office-workers.js';
import { mergeOpenCodeConfigContent, openCodePluginSpecifier, writeOpenCodePlugin, type OpenCodeStatusEvent } from '../opencode.js';
import { reportedUsage } from '../reported-usage.js';
import type { WorkerHandle } from '../workers/types.js';
import { truncate } from '../workers/util.js';
import type { ProviderAdapter } from './types.js';
import { interactionResource, redactInteractionText, type ProviderInteractionDraft, type ProviderInteractionResult } from '../interactions.js';

/** What a worker that reports statuses (OpenCode's plugin, Pi's extension) keeps of them. */
export interface StatusState {
  /** An error keeps the desk visibly actionable until a new turn starts. */
  error?: boolean;
}

/** Where a provider's statuses differ (see reduceStatus). */
export interface StatusOptions {
  /** Each event it takes, once its session is settled. */
  onReport?(): void;
  /** Its session starting leaves it idle whatever it was doing, not only while it was starting up. */
  idleOnStart?: boolean;
}

interface OpenCodeSetup {
  plugin: string;
  mcpScript?: string;
}

function withoutOpenCodeModel(args: string[]): string[] {
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith('--model=') || (arg.startsWith('-m') && arg.length > 2)) continue;
    clean.push(arg);
  }
  return clean;
}

function isOpenCodeHookEvent(value: unknown): value is OpenCodeStatusEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && ['session', 'prompt', 'tool', 'permission', 'question', 'error'].includes(v.type)
    && typeof v.sessionId === 'string' && v.sessionId.length > 0
    && typeof v.status === 'string' && ['starting', 'working', 'needs_input', 'done'].includes(v.status)
    && (v.prompt === undefined || typeof v.prompt === 'string')
    && (v.tool === undefined || typeof v.tool === 'string')
    && (v.detail === undefined || typeof v.detail === 'string');
}

const rec = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** OpenCode's plugin SDK can answer both native permission and question requests by request id. */
export function openCodeInteraction(payload: unknown): ProviderInteractionDraft | undefined {
  if (!rec(payload) || typeof payload.sessionId !== 'string' || typeof payload.requestId !== 'string') return undefined;
  const correlationId = `${payload.sessionId}:${payload.type}:${payload.requestId}`;
  if (payload.type === 'permission') {
    const permission = redactInteractionText(payload.permission, 160) ?? 'tool';
    const patterns = Array.isArray(payload.patterns) ? payload.patterns.map((value) => redactInteractionText(value, 500)).filter((value): value is string => !!value).slice(0, 20) : [];
    const metadata = rec(payload.metadata) ? payload.metadata : {};
    const resource = interactionResource(permission, { description: patterns.join('\n') || JSON.stringify(metadata) });
    return {
      correlationId,
      awaitProviderAck: true,
      kind: 'permission',
      title: `${permission} needs permission`,
      prompt: `Allow OpenCode to use ${permission}?`,
      description: 'OpenCode offers these three native outcomes. “Always” saves the provider-proposed patterns for this project.',
      resource,
      impact: patterns.length ? `Provider-proposed project patterns:\n${patterns.join('\n')}` : resource,
      options: [
        { id: 'once', label: 'Allow once', description: 'Approve only this pending request.', intent: 'approve', risk: 'caution' },
        { id: 'always', label: 'Always allow proposed scope', description: 'Save OpenCode’s proposed patterns for this project. Configured deny rules still win.', intent: 'approve', risk: 'danger' },
        { id: 'reject', label: 'Reject', description: 'Reject this and other pending permissions in the same session.', intent: 'deny' },
      ],
      respond: (response) => ({ reply: response.optionId }),
    };
  }
  if (payload.type !== 'question' || !Array.isArray(payload.questions)) return undefined;
  const questions = payload.questions.slice(0, 8).filter(rec);
  const fields = questions.flatMap((question, index) => {
    const prompt = redactInteractionText(question.question, 2_000);
    if (!prompt) return [];
    const options = Array.isArray(question.options) ? question.options.slice(0, 20).flatMap((option) => {
      if (!rec(option)) return [];
      const label = redactInteractionText(option.label, 200);
      return label ? [{ label, description: redactInteractionText(option.description, 500) }] : [];
    }) : [];
    return [{
      id: `q${index}`,
      label: redactInteractionText(question.header, 120) ?? `Question ${index + 1}`,
      prompt,
      ...(options.length ? { options } : {}),
      ...(question.multiple === true || question.multiSelect === true ? { multiple: true } : {}),
      text: !options.length || question.custom === true,
    }];
  });
  if (!fields.length) return undefined;
  return {
    correlationId,
    awaitProviderAck: true,
    kind: 'question',
    title: fields.length === 1 ? fields[0].label : `${fields.length} questions`,
    prompt: fields.map((field) => field.prompt).join('\n'),
    description: 'This is a native OpenCode question request.',
    options: [
      { id: 'submit', label: 'Send answer', intent: 'approve', risk: 'safe' },
      { id: 'reject', label: 'Reject', intent: 'deny' },
    ],
    fields,
    respond(response) {
      if (response.optionId === 'reject') return { reject: true };
      return { answers: fields.map((field) => response.answers?.[field.id] ?? []) };
    },
  };
}

/** OpenCode confirms the SDK call separately from the original blocking hook response. */
export function openCodeInteractionResult(payload: unknown): ProviderInteractionResult | undefined {
  if (!rec(payload) || payload.type !== 'interaction-result' || typeof payload.sessionId !== 'string' || typeof payload.requestId !== 'string') return undefined;
  const requestType = payload.requestType === 'permission' || payload.requestType === 'question' ? payload.requestType : undefined;
  if (!requestType || typeof payload.ok !== 'boolean') return undefined;
  const status = payload.status === 'denied' || payload.status === 'cancelled' || payload.status === 'resolved' ? payload.status : undefined;
  return {
    correlationId: `${payload.sessionId}:${requestType}:${payload.requestId}`,
    ok: payload.ok,
    ...(status ? { status } : {}),
    ...(typeof payload.decision === 'string' ? { decision: payload.decision } : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}

/** OpenCode plugin callback. The plugin has already filtered child sessions before this bridge. */
function openCodeHook(h: WorkerHandle<StatusState>, _event: string, payload: unknown): boolean {
  const { info } = h;
  if (rec(payload) && payload.type === 'interaction-result') return !!openCodeInteractionResult(payload);
  if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'usage') {
    const report = payload as { sessionId?: unknown; usage?: unknown };
    const usage = reportedUsage(report.usage);
    if (!usage || !info.sessionId || report.sessionId !== info.sessionId) return false;
    // Full snapshots replace previous totals. They never advance task status or enter the Claude ledger.
    info.usage = usage;
    h.emit();
    h.persist();
    return true;
  }
  return isOpenCodeHookEvent(payload) && reduceStatus(h, payload);
}

/**
 * One status event for a worker. An event from another session is only taken when that session
 * starts, and the worker's task starts over with it. Says whether it was taken.
 */
export function reduceStatus(h: WorkerHandle<StatusState>, payload: OpenCodeStatusEvent, o: StatusOptions = {}): boolean {
  const { info, state } = h;
  if (info.sessionId && info.sessionId !== payload.sessionId && !(payload.type === 'session' && payload.status === 'starting')) return false;
  if (!info.sessionId || (payload.type === 'session' && payload.status === 'starting' && info.sessionId !== payload.sessionId)) {
    const switching = !!info.sessionId;
    info.sessionId = payload.sessionId;
    if (switching) {
      info.usage = undefined;
      h.clearTask();
      info.activity = undefined;
      h.setStatus('idle');
    }
    state.error = false;
    h.persist();
  }
  o.onReport?.();
  if (payload.type === 'error') state.error = true;
  else if (payload.status === 'working' || payload.prompt) state.error = false;
  if (payload.prompt) {
    info.activity = truncate(payload.prompt, 80);
    info.action = undefined;
    h.notePrompt(payload.prompt);
  } else if (payload.tool) {
    info.activity = truncate(payload.tool, 80);
    info.action = toolAction(payload.tool);
  } else if (payload.detail) {
    info.activity = truncate(payload.detail, 80);
  }
  if (payload.status === 'needs_input') h.setStatus('needs_input');
  else if (payload.status === 'working') h.setStatus('working');
  else if (payload.status === 'done' && h.running) h.setStatus(state.error ? 'needs_input' : 'done');
  else if (payload.status === 'starting' && (info.status === 'starting' || o.idleOnStart)) h.setStatus('idle');
  else h.emit();
  return true;
}

export const opencode: ProviderAdapter<StatusState, OpenCodeSetup> = {
  id: 'opencode',
  createState: () => ({}),
  prepare: ({ dataDir, mcpScript }) => ({ plugin: writeOpenCodePlugin(dataDir), mcpScript }),
  launch({ h, args, prompt, resumeSessionId, setup }) {
    const { info } = h;
    if (resumeSessionId || info.model) args = withoutOpenCodeModel(args);
    if (!resumeSessionId && info.model) args.push('--model', info.model);
    if (resumeSessionId) args.push('--session', resumeSessionId);
    if (prompt) args.push('--prompt', prompt);
    h.state.error = false;
    return {
      args,
      rotateToken: true,
      finishEnv(env) {
        env.AGENT_OFFICE_SESSION_ID = resumeSessionId ?? '';
        env.OPENCODE_CONFIG_CONTENT = mergeOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT, openCodePluginSpecifier(setup.plugin), setup.mcpScript ? openCodeMcp(setup.mcpScript) : undefined);
      },
    };
  },
  hook: {
    strictJson: true,
    handle: openCodeHook,
    interaction: (_h, _event, payload) => openCodeInteraction(payload),
    interactionResult: (_h, _event, payload) => openCodeInteractionResult(payload),
  },
  usage: { persisted: true },
};
