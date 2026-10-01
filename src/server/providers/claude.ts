// Claude Code: hooks from a settings file the office writes (its own hook route, /hooks/claude),
// usage read off the session transcript and booked in the budget, and tasks the office names.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAILS_TO_DESPAIR, outputFailed, toolAction } from '../../shared/actions.js';
import { MCP_READ_ONLY, writeClaudeMcpConfig } from '../office-workers.js';
import { QUEUE_AGENT_DISALLOWED_TOOLS } from '../stations.js';
import { answered, notified, wantsPermission } from '../workers/lifecycle.js';
import { shq } from '../workers/process.js';
import type { WorkerHandle } from '../workers/types.js';
import { truncate } from '../workers/util.js';
import type { ProviderAdapter } from './types.js';
import { interactionResource, redactInteractionText, type ProviderInteractionDraft } from '../interactions.js';
import type { PendingInteractionResponse } from '../../shared/protocol.js';

/** First-run screens Claude shows before it can take a prompt. */
const SETUP_PROMPT = /trust this folder|Do you trust the files|Select login method|Choose the text style|Press Enter to continue|Bypass Permissions mode/i;
const NOT_LOGGED_IN = /Not logged in\s*·\s*Run \/login|Invalid API key|Please run \/login/i;

interface ClaudeSetup {
  /** Its --settings: the office's hooks. */
  settings: string;
  /** Its --mcp-config: the office's MCP server. */
  mcp?: string;
}

const rec = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

/** Normalize only Claude's documented blocking hook contracts; unknown events keep the terminal fallback. */
export function claudeInteraction(event: string, payload: unknown): ProviderInteractionDraft | undefined {
  if (!rec(payload)) return undefined;
  const session = text(payload.session_id);
  const tool = text(payload.tool_name);
  const input = rec(payload.tool_input) ? payload.tool_input : {};
  const toolUseId = text(payload.tool_use_id);
  if (!session || !tool) return undefined;
  const correlation = `${session}:${event}:${toolUseId ?? digest([tool, input])}`;

  if (event === 'PreToolUse' && tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const questions = input.questions.slice(0, 8).filter(rec);
    const fields = questions.flatMap((q, index) => {
      const prompt = redactInteractionText(q.question, 2_000);
      if (!prompt) return [];
      const choices = Array.isArray(q.options)
        ? q.options.slice(0, 20).filter(rec).flatMap((o) => {
            const label = redactInteractionText(o.label, 200);
            return label ? [{ label, description: redactInteractionText(o.description, 500) }] : [];
          })
        : [];
      return [{
        id: `q${index}`,
        label: redactInteractionText(q.header, 120) ?? `Question ${index + 1}`,
        prompt,
        options: choices.length ? choices : undefined,
        multiple: q.multiSelect === true,
        text: !choices.length || q.isOther === true,
        secret: q.isSecret === true,
      }];
    });
    if (!fields.length) return undefined;
    return {
      correlationId: correlation,
      kind: 'question',
      title: fields.length === 1 ? fields[0].label : `${fields.length} questions`,
      prompt: fields.map((f) => f.prompt).join('\n'),
      description: 'Claude is waiting for structured user input.',
      options: [
        { id: 'submit', label: 'Send answer', intent: 'approve', risk: 'safe' },
        { id: 'cancel', label: 'Cancel', intent: 'cancel' },
      ],
      fields,
      respond(response) {
        if (response.optionId === 'cancel') return claudePreToolDecision('deny', undefined, 'Cancelled in Agent Office');
        const answers: Record<string, string> = {};
        fields.forEach((field) => {
          const index = Number(field.id.slice(1));
          const original = questions[index];
          const question = text(original.question);
          const values = response.answers?.[field.id] ?? [];
          if (question) answers[question] = field.multiple ? values.join(', ') : (values[0] ?? '');
        });
        return claudePreToolDecision('allow', { ...input, answers });
      },
    };
  }

  if (event === 'PreToolUse' && tool === 'ExitPlanMode') {
    return {
      correlationId: correlation,
      kind: 'confirmation',
      title: 'Continue from the plan?',
      prompt: redactInteractionText(input.plan, 4_000) ?? 'Claude wants to leave plan mode and continue.',
      description: 'Confirming lets the current turn proceed. Cancelling returns the refusal to Claude.',
      options: [
        { id: 'continue', label: 'Continue', intent: 'approve', risk: 'caution' },
        { id: 'cancel', label: 'Cancel', intent: 'cancel' },
      ],
      respond: (response) => claudePreToolDecision(response.optionId === 'continue' ? 'allow' : 'deny', response.optionId === 'continue' ? input : undefined, response.optionId === 'continue' ? undefined : 'Cancelled in Agent Office'),
    };
  }

  if (event !== 'PermissionRequest') return undefined;
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions.filter(rec).slice(0, 8) : [];
  const options = [
    { id: 'allow-once', label: 'Allow once', description: 'Allow only this request.', intent: 'approve' as const, risk: 'caution' as const },
    ...suggestions.map((suggestion, index) => ({
      id: `suggestion-${index}`,
      label: permissionSuggestionLabel(suggestion),
      description: 'Apply the exact scope suggested by Claude Code.',
      intent: 'approve' as const,
      risk: 'danger' as const,
    })),
    { id: 'deny', label: 'Deny', description: 'Refuse this request and let Claude continue.', intent: 'deny' as const },
  ];
  const resource = interactionResource(tool, input);
  return {
    correlationId: correlation,
    kind: 'permission',
    title: `${tool} needs permission`,
    prompt: text(input.description) ?? `Allow Claude to use ${tool}?`,
    description: 'This is a native Claude Code permission callback.',
    resource,
    impact: resource,
    risk: destructiveRisk(resource),
    options,
    respond(response: PendingInteractionResponse) {
      if (response.optionId === 'deny') return claudePermissionDecision('deny', undefined, 'Denied in Agent Office');
      const suggestion = /^suggestion-(\d+)$/.exec(response.optionId ?? '');
      return claudePermissionDecision('allow', suggestion ? [suggestions[Number(suggestion[1])]] : undefined);
    },
  };
}

function claudePreToolDecision(decision: 'allow' | 'deny', updatedInput?: Record<string, unknown>, reason?: string) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}), ...(updatedInput ? { updatedInput } : {}) } };
}

function claudePermissionDecision(behavior: 'allow' | 'deny', updatedPermissions?: Record<string, unknown>[], message?: string) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...(updatedPermissions?.length ? { updatedPermissions } : {}), ...(message ? { message } : {}) } } };
}

function permissionSuggestionLabel(suggestion: Record<string, unknown>): string {
  if (suggestion.type === 'setMode' && typeof suggestion.mode === 'string') return `Allow and set ${suggestion.mode} mode`;
  if (suggestion.type === 'addDirectories') return 'Allow and add suggested directories';
  if (suggestion.type === 'addRules') return 'Allow and add suggested rule';
  return 'Allow with suggested scope';
}

function destructiveRisk(resource: string | undefined): string | undefined {
  if (!resource) return undefined;
  return /(?:rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-f)|drop\s+(?:table|database)|destroy|delete)/i.test(resource)
    ? 'Potentially destructive operation. Review the exact command or resource before allowing.'
    : undefined;
}

/** Claude Code's --settings for every worker: each hook event posted to the office, with curl or else the office's own node. */
function writeHookSettings(dataDir: string): string {
  const settingsPath = path.join(dataDir, 'claude-hooks.json');
  const events: [string, string | undefined][] = [
    ['SessionStart', undefined],
    ['UserPromptSubmit', undefined],
    ['Stop', undefined],
    ['Notification', undefined],
    ['PermissionRequest', undefined],
    ['PreToolUse', undefined],
    ['PostToolUse', undefined],
    ['PostToolUseFailure', undefined],
  ];
  // The office's own node is always present. Blocking hooks keep this helper alive until the UI
  // answers; if the office restarts, it reconnects with the same provider correlation payload.
  const nodeHook = path.join(dataDir, 'hook.cjs');
  writeFileSync(
    nodeHook,
    `const http = require('http');
const [event] = process.argv.slice(2);
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  if (body.length > 262144) return process.stdout.write('{}');
  let payload = {};
  try { payload = JSON.parse(body); } catch {}
  const blocking = event === 'PermissionRequest' || (event === 'PreToolUse' && (payload.tool_name === 'AskUserQuestion' || payload.tool_name === 'ExitPlanMode'));
  let tries = blocking ? Infinity : 6;
  const url = new URL(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/claude');
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const send = () => {
    const req = http.request(url, { method: 'POST', ...(blocking ? {} : { timeout: 3000 }), headers: { authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        if (res.statusCode === 200) return process.stdout.write(out || '{}');
        if (res.statusCode === 503 && --tries > 0) return setTimeout(send, 1000);
        process.stdout.write('{}');
      });
    });
    req.on('error', (err) => {
      if ((err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') && --tries > 0) setTimeout(send, 1000);
      else process.stdout.write('{}');
    });
    req.on('timeout', () => req.destroy());
    req.end(body);
  };
  send();
});
`,
    { mode: 0o600 },
  );
  const hooks: Record<string, unknown[]> = {};
  for (const [event, matcher] of events) {
    const command =
      `if [ -z "$AGENT_OFFICE_WORKER_ID" ] || [ -z "$AGENT_OFFICE_HOOK_URL" ]; then exit 0; fi; ` +
      `${shq(process.execPath)} ${shq(nodeHook)} ${event}`;
    const timeout = event === 'PermissionRequest' || event === 'PreToolUse' ? 86400 : 3;
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] }];
  }
  // Looking at the office's workers doesn't need anyone's say-so; hiring and sending home still asks.
  const permissions = { allow: MCP_READ_ONLY };
  writeFileSync(settingsPath, JSON.stringify({ hooks, permissions }, null, 2), { mode: 0o600 });
  return settingsPath;
}

function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}

/**
 * A tool call finished. Tests or a build that failed again (by exit code, or by the summary it
 * printed when the exit code was piped away) and the worker puts its head in its hands, until its
 * next tool call; a passing run ends the streak.
 */
function noteOutcome(h: WorkerHandle, payload: any, failed: boolean) {
  if (payload?.is_interrupt || toolAction(payload?.tool_name, payload?.tool_input) !== 'test') return;
  const res = payload?.tool_response;
  const output = [payload?.error, res?.stdout, res?.stderr].filter((s) => typeof s === 'string').join('\n');
  if (!failed && !outputFailed(output)) {
    h.failStreak = 0;
    return;
  }
  if (++h.failStreak < FAILS_TO_DESPAIR || h.info.action === 'failing') return;
  h.info.action = 'failing';
  h.emit();
}

/**
 * Claude Code hook callback. Any session id or transcript it names is the worker's now, and a
 * malformed payload still counts as the event. The trust and login screens are also read off its
 * screen (see blocked), so only a prompt or its session starting clears bootBlocked here.
 */
function claudeHook(h: WorkerHandle, event: string, payload: any): boolean {
  const { info } = h;
  const now = Date.now();
  if (payload?.session_id && typeof payload.session_id === 'string' && payload.session_id !== info.sessionId) {
    info.sessionId = payload.session_id;
    h.persist();
  }
  if (typeof payload?.transcript_path === 'string' && payload.transcript_path !== h.tracker.transcript) {
    h.tracker.transcript = payload.transcript_path;
    h.persist();
  }
  h.scheduleScan();
  switch (event) {
    case 'SessionStart':
      if (payload?.source === 'clear') {
        h.clearTask();
        h.failStreak = 0;
      }
      if (info.status === 'starting' || (h.bootBlocked && info.status === 'needs_input')) {
        h.bootBlocked = false;
        h.setStatus('idle');
      }
      break;
    case 'UserPromptSubmit':
      h.bootBlocked = false;
      info.action = undefined;
      if (typeof payload?.prompt === 'string') {
        info.activity = truncate(payload.prompt, 80);
        h.notePrompt(payload.prompt);
      }
      if (info.status !== 'working') h.setStatus('working');
      else h.emit();
      break;
    case 'PreToolUse':
      if (payload?.tool_name === 'AskUserQuestion') h.setStatus('needs_input');
      else {
        info.activity = describeTool(payload);
        info.action = toolAction(payload?.tool_name, payload?.tool_input);
        h.noteTool(info.activity);
        if (info.status !== 'working') h.setStatus('working');
        else h.emit();
      }
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      noteOutcome(h, payload, event === 'PostToolUseFailure');
      answered(h, now);
      break;
    case 'PermissionRequest':
      wantsPermission(h, describeTool(payload));
      break;
    case 'Notification':
      notified(h, payload?.notification_type, now);
      break;
    case 'Stop':
      h.setStatus('done');
      break;
  }
  return true;
}

/**
 * Claude can sit at its prompt without being usable: stuck on a first-run screen, or not signed in
 * on this machine. That needs a human, until the screen moves on.
 */
export function claudeBlocked(text: string, early: boolean): string | undefined {
  if (NOT_LOGGED_IN.test(text)) return "Claude isn't signed in on this machine — open the terminal and type /login";
  if (SETUP_PROMPT.test(text) && early) return 'Waiting on a setup prompt (trust / login) — open the terminal';
  return undefined;
}

export const claude: ProviderAdapter<undefined, ClaudeSetup> = {
  id: 'claude',
  scrubEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT'],
  scrubPrefixes: ['CLAUDE_CODE_SESSION', 'CLAUDE_CODE_CHILD', 'CLAUDE_CODE_MESSAGING'],
  prepare: ({ dataDir, mcpScript }) => ({
    settings: writeHookSettings(dataDir),
    mcp: mcpScript ? writeClaudeMcpConfig(dataDir, mcpScript) : undefined,
  }),
  launch({ h: { info }, args, prompt, resumeSessionId, station, setup }) {
    args.unshift('--settings', setup.settings);
    // The office's MCP server: its workers, to list, hire, send home and tell (see office-workers.ts).
    // Ahead of --settings, which ends the list --mcp-config takes.
    if (setup.mcp) args.unshift('--mcp-config', setup.mcp);
    // A model/effort chosen for this worker overrides whatever --agent-args set office-wide.
    if (info.model) args.push('--model', info.model);
    if (info.effort) args.push('--effort', info.effort);
    // The queue agent only ever adds to the queue: without these it can't touch the checkout's files.
    if (station === 'queue') args.push('--disallowedTools', ...QUEUE_AGENT_DISALLOWED_TOOLS);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    // `--` so a prompt like "- fix login" is never parsed as a CLI option.
    if (prompt) args.push('--', prompt);
    return { args };
  },
  signIn: 'claude',
  // SessionStart fires as soon as Claude can take input: still silent, it's blocked on a human.
  bootHint: 'Waiting on a setup prompt (trust / login) — open the terminal',
  titleNoise: /^claude( code)?$/i,
  // Resuming a conversation Claude no longer has ("No conversation found") exits before Claude ever starts.
  freshIfResumeFails: true,
  hook: { strictJson: false, handle: claudeHook, interaction: (_h, event, payload) => claudeInteraction(event, payload) },
  // OSC 9;4 progress (Claude Code emits it): 0 = idle, anything else = busy. Catches Esc-cancel,
  // which fires no Stop hook.
  screen: { progress: true, blocked: claudeBlocked },
  usage: { transcript: true },
  namesTasks: true,
};
