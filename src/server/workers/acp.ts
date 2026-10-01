// A worker that runs over ACP rather than in a terminal (DeepSeek Harness, see ProviderAdapter.transport):
// the office holds the connection and draws what it says into the worker's terminal itself.
import { DshSession, terminalSafe, type DshPermissionOption } from '../dsh.js';
import { interactionResource, safeInteractionText, type ProviderInteractionDraft } from '../interactions.js';
import type { HeadlessTerminal } from './terminal.js';
import type { Worker, WorkerContext } from './types.js';
import { truncate } from './util.js';

/**
 * Starts (or resumes) a DeepSeek Harness worker over ACP. The session renders its transcript into
 * the worker's terminal and reports status, acted-out actions, usage and its session id; the
 * office answers permission requests from whoever is typing (see dsh.ts).
 */
export function launchAcp(ctx: WorkerContext, w: Worker, term: HeadlessTerminal, options: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; resumeSessionId?: string; prompt?: string }) {
  const { info } = w;
  const session = new DshSession(
    {
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      model: info.model,
      effort: info.effort,
      resumeSessionId: options.resumeSessionId,
      firstPrompt: options.prompt,
    },
    {
      output: (data) => {
        if (w.dsh !== session) return;
        term.write(data);
        w.screenDirty = true;
        w.unsaved = true;
        if (w.viewers.size) ctx.events.data(info.id, data, [...w.viewers.keys()]);
      },
      status: (status) => {
        if (w.dsh === session) ctx.setStatus(w, status);
      },
      action: (action) => {
        if (w.dsh !== session || info.action === action) return;
        info.action = action;
        ctx.emit(w);
      },
      usage: (usage) => {
        if (w.dsh !== session) return;
        info.usage = usage;
        ctx.emit(w);
        ctx.persist();
      },
      session: (sessionId) => {
        if (w.dsh !== session || info.sessionId === sessionId) return;
        info.sessionId = sessionId;
        ctx.emit(w);
        ctx.persist();
      },
      prompted: (text) => {
        // A line typed into the terminal: there are no hooks for DSH, so the card learns from here.
        if (w.dsh !== session) return;
        ctx.notePrompt(w, text);
        ctx.emit(w);
      },
      permission: async (id, params, options) => {
        if (w.dsh !== session) return undefined;
        const request = dshPermission(info, session.id, id, params, options);
        if (!ctx.events.interact) return new Promise<string | undefined>(() => {});
        return (await ctx.events.interact({ ...info }, request)) as string | undefined;
      },
      permissionClosed: () => ctx.events.cancelInteractions?.(info.id),
      exit: (code, error, quiet) => acpExited(ctx, w, session, term, code, error, quiet),
    },
  );
  w.dsh = session;
  session.start();
}

function dshPermission(info: Worker['info'], sessionId: string | undefined, id: unknown, params: unknown, options: DshPermissionOption[]): ProviderInteractionDraft {
  const data = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const toolCall = data.toolCall && typeof data.toolCall === 'object' && !Array.isArray(data.toolCall) ? data.toolCall as Record<string, unknown> : {};
  const title = safeInteractionText(toolCall.title ?? toolCall.name, 160) || 'Tool';
  const input = toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput) ? toolCall.rawInput as Record<string, unknown> : {};
  const resource = interactionResource(title, input);
  const choices = options.map((option) => ({
    id: option.optionId,
    label: option.name,
    description: option.once ? 'This choice applies only to the current request.' : `Provider scope: ${option.kind}`,
    intent: /reject|deny/.test(option.kind) ? 'deny' as const : /cancel/.test(option.kind) ? 'cancel' as const : 'approve' as const,
    risk: /reject|deny|cancel/.test(option.kind) ? 'safe' as const : 'caution' as const,
  }));
  return {
    correlationId: `${sessionId ?? info.sessionId ?? 'starting'}:${JSON.stringify(id)}`,
    kind: 'permission',
    title: `${title} needs permission`,
    prompt: `Allow DeepSeek Harness to run ${title}?`,
    description: 'This is the native ACP permission request and its exact advertised choices.',
    resource,
    impact: resource,
    options: choices,
    respond: (response) => response.optionId,
  };
}

/** A DeepSeek Harness child ended: while the office is up, its desk says so and R resumes it. */
function acpExited(ctx: WorkerContext, w: Worker, session: DshSession, term: HeadlessTerminal, code: number | null, error: string | undefined, quiet: boolean) {
  const { info } = w;
  if (w.dsh !== session || ctx.workers.get(info.id) !== w) return; // sent home: stay quiet
  w.dsh = undefined;
  // The office is going down: the next office marks this worker offline and resumes it, so its
  // status must stay as it was (see the restart difference in docs/dsh-acp-integration.md).
  if (quiet || ctx.closing) return;
  ctx.events.cancelInteractions?.(info.id);
  const note = error ? `\r\n\x1b[31m[DeepSeek Harness: ${terminalSafe(truncate(error, 300)).replace(/\n/g, ' ')}]\x1b[0m\r\n` : '';
  if (note) {
    term.write(note);
    if (w.viewers.size) ctx.events.data(info.id, note, [...w.viewers.keys()]);
  }
  // It never got as far as a session: most often `dsh` is missing, or the profile will not boot.
  if (error && !info.sessionId) ctx.events.toast(`Could not start ${ctx.command(info)}: ${truncate(error, 200)}`, 'error');
  info.exitCode = code ?? -1;
  info.status = 'exited';
  const hint = info.sessionId ? ' — press R to resume' : '';
  const msg = `\r\n\x1b[2m[${info.name} exited with code ${code ?? -1}${hint}]\x1b[0m\r\n`;
  term.write(msg);
  if (w.viewers.size) ctx.events.data(info.id, msg, [...w.viewers.keys()]);
  w.screenDirty = true;
  w.unsaved = true;
  ctx.emit(w);
  ctx.persist();
}
