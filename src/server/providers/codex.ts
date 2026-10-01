// Codex: its native lifecycle hooks (see ../codex.ts), set on its command line, report on
// /hooks/codex; its usage is read from the root session's rollout (see codex-usage.ts).
import { homedir } from 'node:os';
import path from 'node:path';
import { codexHookArgs, normalizeCodexHook, writeCodexHook } from '../codex.js';
import { CodexUsageReader } from '../codex-usage.js';
import { codexMcpArgs } from '../office-workers.js';
import { reduceLifecycle, type ToolTracker } from '../workers/lifecycle.js';
import type { WorkerHandle } from '../workers/types.js';
import type { ProviderAdapter } from './types.js';
import { createHash } from 'node:crypto';
import { interactionResource, redactInteractionText, type ProviderInteractionDraft } from '../interactions.js';

interface CodexState {
  usage: CodexUsageReader;
  /** Where its sessions are logged (see codexHome). */
  home?: string;
  /** Its root session's rollout, as its hooks name it. */
  transcript?: string;
  /** Its tool calls in flight, and which of them wait on the person (see tracker). */
  tools: Map<string, string>;
  pending: Set<string>;
  permissionUnknown?: boolean;
}

interface CodexSetup {
  hook: string;
  mcpScript?: string;
}

const rec = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const valueText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Codex's native PermissionRequest hook supports exactly one-shot allow or deny today. */
export function codexInteraction(event: string, payload: unknown): ProviderInteractionDraft | undefined {
  if (!rec(payload) || valueText(payload.agent_id) || valueText(payload.agent_type)) return undefined;
  const session = valueText(payload.session_id);
  const tool = valueText(payload.tool_name);
  if (!session || !tool) return undefined;
  const input = rec(payload.tool_input) ? payload.tool_input : {};
  const toolUseId = valueText(payload.tool_use_id);
  const correlation = `${session}:${toolUseId ?? createHash('sha256').update(JSON.stringify([tool, input])).digest('hex').slice(0, 24)}`;
  if (event === 'PreToolUse' && /(?:^|[._])request_user_input$/.test(tool) && Array.isArray(input.questions)) {
    const first = input.questions.find(rec);
    return {
      correlationId: correlation,
      kind: 'unsupported',
      title: 'Codex is asking a question',
      prompt: redactInteractionText(first?.question ?? first?.prompt, 2_000) ?? 'Codex needs structured user input.',
      description: 'The Codex CLI hook reports request_user_input but has no callback contract for returning the selected answer. Answer this request in the worker terminal.',
      options: [],
      timeoutMs: 5 * 60_000,
      respond: () => ({}),
    };
  }
  if (event !== 'PermissionRequest') return undefined;
  const resource = interactionResource(tool, input);
  return {
    correlationId: correlation,
    kind: 'approval',
    title: `${tool} needs approval`,
    prompt: valueText(input.description) ?? `Allow Codex to use ${tool}?`,
    description: 'Codex supports one-shot allow or deny for this native hook request.',
    resource,
    impact: resource,
    risk: resource && /(?:rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-f)|drop\s+(?:table|database)|destroy|delete)/i.test(resource)
      ? 'Potentially destructive operation. Review the exact command or resource before allowing.'
      : undefined,
    options: [
      { id: 'allow', label: 'Allow once', description: 'Allow only this request.', intent: 'approve', risk: 'caution' },
      { id: 'deny', label: 'Deny', description: 'Refuse this request and let Codex continue.', intent: 'deny' },
    ],
    respond(response) {
      const allow = response.optionId === 'allow';
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: allow ? 'allow' : 'deny', ...(!allow ? { message: 'Denied in Agent Office' } : {}) },
        },
      };
    },
  };
}

/** Where a Codex worker's sessions are logged, for reading its usage. */
function codexHome(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(cwd, env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex'));
}

/**
 * Codex's hooks never say a question was answered, so its tool calls are followed one by one: one
 * that asks the person something, or wants permission, keeps it needing input until it's over.
 */
function tracker(s: CodexState): ToolTracker {
  return {
    clear() {
      s.tools.clear();
      s.pending.clear();
      s.permissionUnknown = false;
    },
    started(tool, toolUseId) {
      if (toolUseId && s.tools.size < 256) s.tools.set(toolUseId, tool ?? '');
      if (/(?:^|[.])(?:AskUserQuestion|request_user_input)$/.test(tool ?? '')) {
        if (toolUseId) s.pending.add(toolUseId);
        else s.permissionUnknown = true;
      }
    },
    permission(tool) {
      // PermissionRequest has no tool_use_id in the native schema. Keep every matching
      // active call pending so an unrelated parallel tool cannot dismiss the prompt.
      const candidates = [...s.tools].filter(([, t]) => t === tool);
      if (!candidates.length) s.permissionUnknown = true;
      for (const [id] of candidates) s.pending.add(id);
    },
    finished(toolUseId) {
      if (toolUseId) {
        s.tools.delete(toolUseId);
        s.pending.delete(toolUseId);
      }
    },
    waiting: () => !!(s.pending.size || s.permissionUnknown),
  };
}

/** Native Codex lifecycle hooks register the root rollout for bounded metric reads. */
function codexHook(h: WorkerHandle<CodexState>, event: string, payload: unknown): boolean {
  const report = normalizeCodexHook(event, payload);
  if (!report) return false;
  const s = h.state;
  return reduceLifecycle(h, report, {
    onSessionSwitch() {
      h.info.usage = undefined;
      s.transcript = undefined;
      s.usage = new CodexUsageReader();
    },
    onReport() {
      if (report.transcriptPath) s.transcript = report.transcriptPath;
      h.scheduleScan();
    },
    tools: tracker(s),
  });
}

export const codex: ProviderAdapter<CodexState, CodexSetup> = {
  id: 'codex',
  scrubEnv: ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'],
  createState: () => ({ usage: new CodexUsageReader(), tools: new Map(), pending: new Set() }),
  prepare: ({ dataDir, mcpScript }) => ({ hook: writeCodexHook(dataDir), mcpScript }),
  launch({ h, args, prompt, resumeSessionId, setup }) {
    args.push(...codexHookArgs(setup.hook), ...(setup.mcpScript ? codexMcpArgs(setup.mcpScript) : []), '--no-alt-screen');
    if (resumeSessionId) args.push('resume', resumeSessionId);
    if (prompt) args.push('--', prompt);
    tracker(h.state).clear();
    return { args, rotateToken: true };
  },
  bootHint: 'Open the terminal: complete login and review Office hooks in /hooks',
  hook: { strictJson: true, handle: codexHook, interaction: (_h, event, payload) => codexInteraction(event, payload) },
  usage: {
    persisted: true,
    scanOnExit: true,
    scan(h) {
      const { info, state: s } = h;
      if (!s.transcript || !s.home || !info.sessionId) return;
      const usage = s.usage.read(s.transcript, info.sessionId, s.home);
      if (usage && JSON.stringify(usage) !== JSON.stringify(info.usage)) {
        info.usage = usage;
        h.emit();
        h.persist();
      }
    },
    locate(h, cwd, env) {
      h.state.home = codexHome(cwd, env);
    },
    save: (s) => ({ codexTranscript: s.transcript }),
    restore(s, saved) {
      if (typeof saved.codexTranscript === 'string') s.transcript = saved.codexTranscript;
    },
  },
};
