import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  PendingInteraction,
  PendingInteractionField,
  PendingInteractionKind,
  PendingInteractionOption,
  PendingInteractionResponse,
  PendingInteractionStatus,
  WorkerInfo,
} from '../shared/protocol.js';
import type { AgentProvider } from '../shared/providers.js';

const MAX_TEXT = 4_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60_000;
const TERMINAL_KEEP_MS = 30_000;
const SECRET = /\b(?:authorization|bearer|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_SECRET = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const BEARER = /\b((?:authorization\s*[:=]\s*)?bearer)\s+[^\s,;]+/gi;
const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g;

export interface InteractionRequest {
  /** Stable for retries of the same provider callback, unique within this worker. */
  correlationId: string;
  kind: PendingInteractionKind;
  title: string;
  prompt: string;
  description?: string;
  resource?: string;
  impact?: string;
  risk?: string;
  options: PendingInteractionOption[];
  fields?: PendingInteractionField[];
  timeoutMs?: number;
  /** The adapter will confirm that its provider accepted the reply before the UI resolves it. */
  awaitProviderAck?: boolean;
}

/** Browser-safe request plus the provider-specific response encoder kept only in memory. */
export interface ProviderInteractionDraft extends InteractionRequest {
  respond(response: PendingInteractionResponse): unknown;
}

export interface ProviderInteractionResult {
  correlationId: string;
  ok: boolean;
  status?: 'resolved' | 'denied' | 'cancelled';
  decision?: string;
  error?: string;
}

export function redactInteractionText(value: unknown, max = MAX_TEXT): string | undefined {
  return safeInteractionText(value, max) || undefined;
}

export function interactionResource(tool: string, input: Record<string, unknown>): string | undefined {
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  const detail = redactInteractionText(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value), 1_500);
  return redactInteractionText(detail ? `${tool}: ${detail}` : tool, 1_700);
}

export interface InteractionOrigin {
  worker: WorkerInfo;
  floorId: string;
  floorName: string;
}

interface RecordState {
  correlation: string;
  item: PendingInteraction;
  response?: PendingInteractionResponse;
  by?: { id: string; name: string };
  awaitProviderAck: boolean;
  waiters: Set<(response: PendingInteractionResponse) => void>;
  timer?: NodeJS.Timeout;
  removeTimer?: NodeJS.Timeout;
}

interface SavedRecord {
  correlation: string;
  item: PendingInteraction;
  awaitProviderAck?: boolean;
}

/** Bounded plain text for UI and disk. It deliberately catches common credentials, not arbitrary prose. */
export function safeInteractionText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(URL_SECRET, '$1[REDACTED]@')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(ENV_SECRET, '$1=[REDACTED]')
    .replace(SECRET, (match) => `${match.slice(0, match.search(/[:=]/) + 1)} [REDACTED]`)
    .slice(0, max)
    .trim();
}

export function interactionCorrelation(workerId: string, provider: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return `${workerId}:${provider}:${digest}`;
}

function cleanOption(option: PendingInteractionOption): PendingInteractionOption | undefined {
  const id = safeInteractionText(option.id, 128);
  const label = safeInteractionText(option.label, 160);
  if (!id || !label || !['approve', 'deny', 'cancel', 'choice'].includes(option.intent)) return undefined;
  return {
    id,
    label,
    intent: option.intent,
    ...(option.description ? { description: safeInteractionText(option.description, 600) } : {}),
    ...(option.risk ? { risk: option.risk } : {}),
  };
}

function cleanField(field: PendingInteractionField): PendingInteractionField | undefined {
  const id = safeInteractionText(field.id, 128);
  const prompt = safeInteractionText(field.prompt, 1_500);
  if (!id || !prompt) return undefined;
  return {
    id,
    label: safeInteractionText(field.label, 160) || 'Response',
    prompt,
    ...(field.options?.length
      ? { options: field.options.slice(0, 20).map((o) => ({ label: safeInteractionText(o.label, 240), ...(o.description ? { description: safeInteractionText(o.description, 600) } : {}) })).filter((o) => o.label) }
      : {}),
    ...(field.multiple ? { multiple: true } : {}),
    ...(field.secret ? { secret: true } : {}),
    ...(field.text ? { text: true } : {}),
  };
}

function terminal(status: PendingInteractionStatus): boolean {
  return status === 'resolved' || status === 'denied' || status === 'expired' || status === 'cancelled';
}

/** Building-wide pending provider callbacks. Provider-only data stays on the adapter's call stack. */
export class InteractionCenter {
  private readonly file: string;
  private readonly auditFile: string;
  private readonly byId = new Map<string, RecordState>();
  private readonly byCorrelation = new Map<string, RecordState>();

  constructor(
    dataDir: string,
    private emit: (item: PendingInteraction) => void,
    private remove: (id: string, status: Extract<PendingInteractionStatus, 'resolved' | 'denied' | 'expired' | 'cancelled'>) => void,
  ) {
    this.file = path.join(dataDir, 'pending-interactions.json');
    this.auditFile = path.join(dataDir, 'interaction-audit.jsonl');
    this.restore();
  }

  state(): PendingInteraction[] {
    return [...this.byId.values()].map((r) => ({ ...r.item })).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  request(origin: InteractionOrigin, request: InteractionRequest): Promise<PendingInteractionResponse> {
    const provider: AgentProvider = origin.worker.provider ?? 'custom';
    const correlation = `${origin.worker.id}:${provider}:${request.correlationId}`;
    let record = this.byCorrelation.get(correlation);
    if (!record) {
      const now = Date.now();
      const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
      const options = request.options.map(cleanOption).filter((o): o is PendingInteractionOption => !!o).slice(0, 20);
      const fields = request.fields?.map(cleanField).filter((f): f is PendingInteractionField => !!f).slice(0, 12);
      const item: PendingInteraction = {
        id: randomBytes(12).toString('base64url'),
        version: 1,
        workerId: origin.worker.id,
        workerName: safeInteractionText(origin.worker.name, 100) || 'Worker',
        floorId: safeInteractionText(origin.floorId, 128),
        floorName: safeInteractionText(origin.floorName, 160) || 'Workspace',
        provider,
        kind: request.kind,
        status: request.kind === 'unsupported' ? 'error' : 'pending',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + timeoutMs,
        title: safeInteractionText(request.title, 240) || 'Agent needs input',
        prompt: safeInteractionText(request.prompt),
        ...(request.description ? { description: safeInteractionText(request.description) } : {}),
        ...(origin.worker.task?.name ? { task: safeInteractionText(origin.worker.task.name, 240) } : {}),
        ...(request.resource ? { resource: safeInteractionText(request.resource, 1_500) } : {}),
        ...(request.impact ? { impact: safeInteractionText(request.impact, 1_500) } : {}),
        ...(request.risk ? { risk: safeInteractionText(request.risk, 240) } : {}),
        options,
        ...(fields?.length ? { fields } : {}),
        ...(request.kind === 'unsupported' ? { unsupportedReason: safeInteractionText(request.description || request.prompt) } : {}),
      };
      record = { correlation, item, waiters: new Set(), awaitProviderAck: request.awaitProviderAck === true };
      this.byId.set(item.id, record);
      this.byCorrelation.set(correlation, record);
      this.arm(record);
      this.persist();
      this.emit({ ...item });
    } else if (request.awaitProviderAck) record.awaitProviderAck = true;
    if (record.response) return Promise.resolve(record.response);
    if (terminal(record.item.status)) return Promise.reject(new Error(`interaction ${record.item.status}`));
    return new Promise((resolve) => record!.waiters.add(resolve));
  }

  resolve(id: string, version: number, response: PendingInteractionResponse, by: { id: string; name: string }): string | undefined {
    const record = this.byId.get(id);
    if (!record) return 'That request is no longer active';
    if (terminal(record.item.status)) return undefined; // idempotent late/double click
    if (record.item.version !== version) {
      this.emit({ ...record.item });
      return 'That request changed — review its current options before responding';
    }
    const checked = this.validate(record.item, response);
    if (typeof checked === 'string') {
      record.item = { ...record.item, status: 'error', error: checked, updatedAt: Date.now(), version: version + 1 };
      this.persist();
      this.emit({ ...record.item });
      return checked;
    }
    record.item = { ...record.item, status: 'sending', error: undefined, updatedAt: Date.now(), version: version + 1 };
    this.emit({ ...record.item });
    record.response = checked;
    record.by = by;
    const selected = record.item.options.find((o) => o.id === checked.optionId);
    const status: PendingInteractionStatus = selected?.intent === 'deny' ? 'denied' : selected?.intent === 'cancel' ? 'cancelled' : 'resolved';
    queueMicrotask(() => {
      const current = this.byId.get(id);
      if (current !== record || terminal(record.item.status)) return;
      for (const waiter of record.waiters) waiter(checked);
      record.waiters.clear();
      if (record.awaitProviderAck) {
        this.persist();
        return;
      }
      record.item = { ...record.item, status, updatedAt: Date.now(), version: record.item.version + 1 };
      this.audit(record.item, selected?.id ?? (checked.answers ? 'answered' : 'submitted'), by);
      clearTimeout(record.timer);
      this.persist();
      this.emit({ ...record.item });
      this.removeLater(record, status as Extract<PendingInteractionStatus, 'resolved' | 'denied' | 'cancelled'>);
    });
    return undefined;
  }

  /** Provider-side acknowledgement for adapters whose SDK call happens after the hook response. */
  settle(origin: InteractionOrigin, result: ProviderInteractionResult) {
    const provider: AgentProvider = origin.worker.provider ?? 'custom';
    const record = this.byCorrelation.get(`${origin.worker.id}:${provider}:${result.correlationId}`);
    if (!record || terminal(record.item.status) || !record.awaitProviderAck) return;
    if (!result.ok) {
      record.response = undefined;
      record.item = {
        ...record.item,
        status: 'error',
        error: safeInteractionText(result.error, 500) || 'The provider could not accept that response',
        updatedAt: Date.now(),
        version: record.item.version + 1,
      };
      this.persist();
      this.emit({ ...record.item });
      return;
    }
    const status = result.status ?? 'resolved';
    record.item = { ...record.item, status, error: undefined, updatedAt: Date.now(), version: record.item.version + 1 };
    clearTimeout(record.timer);
    this.audit(record.item, safeInteractionText(result.decision, 128) || 'submitted', record.by ?? { id: 'provider', name: 'Provider acknowledgement' });
    this.persist();
    this.emit({ ...record.item });
    this.removeLater(record, status);
  }

  expireWorker(workerId: string, status: 'expired' | 'cancelled' = 'expired') {
    for (const record of this.byId.values()) if (record.item.workerId === workerId && !terminal(record.item.status)) this.finish(record, status);
  }

  fail(correlation: string, message: string) {
    const record = this.byCorrelation.get(correlation);
    if (!record || terminal(record.item.status)) return;
    record.item = { ...record.item, status: 'error', error: safeInteractionText(message, 500) || 'The provider could not accept that response', updatedAt: Date.now(), version: record.item.version + 1 };
    this.persist();
    this.emit({ ...record.item });
  }

  private validate(item: PendingInteraction, response: PendingInteractionResponse): PendingInteractionResponse | string {
    const out: PendingInteractionResponse = {};
    if (response.optionId !== undefined) {
      if (typeof response.optionId !== 'string' || !item.options.some((o) => o.id === response.optionId)) return 'That response is not offered by the provider';
      out.optionId = response.optionId;
    }
    if (item.fields?.length) {
      if (!response.answers || typeof response.answers !== 'object') return 'Answer every required question';
      const answers: Record<string, string[]> = {};
      for (const field of item.fields) {
        const values = response.answers[field.id];
        if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string')) return `Answer “${field.label}”`;
        if (!field.multiple && values.length !== 1) return `Choose one answer for “${field.label}”`;
        const cleaned = values.map((v) => safeInteractionText(v, 2_000)).filter(Boolean);
        if (!cleaned.length) return `Answer “${field.label}”`;
        if (!field.text && field.options?.length && cleaned.some((v) => !field.options!.some((o) => o.label === v))) return `Choose an offered answer for “${field.label}”`;
        answers[field.id] = cleaned;
      }
      out.answers = answers;
    }
    if (!out.optionId && !out.answers) return 'Choose a response';
    return out;
  }

  private arm(record: RecordState) {
    clearTimeout(record.timer);
    const left = Math.max(0, (record.item.expiresAt ?? Date.now()) - Date.now());
    record.timer = setTimeout(() => this.finish(record, 'expired'), left);
    record.timer.unref();
  }

  private finish(record: RecordState, status: 'expired' | 'cancelled') {
    if (terminal(record.item.status)) return;
    record.item = { ...record.item, status, updatedAt: Date.now(), version: record.item.version + 1 };
    clearTimeout(record.timer);
    const fallback = record.item.options.find((option) => option.intent === 'cancel') ?? record.item.options.find((option) => option.intent === 'deny');
    if (fallback) {
      record.response = { optionId: fallback.id };
      for (const waiter of record.waiters) waiter(record.response);
    }
    record.waiters.clear();
    this.persist();
    this.emit({ ...record.item });
    this.removeLater(record, status);
  }

  private removeLater(record: RecordState, status: Extract<PendingInteractionStatus, 'resolved' | 'denied' | 'expired' | 'cancelled'>) {
    clearTimeout(record.removeTimer);
    record.removeTimer = setTimeout(() => {
      if (this.byId.get(record.item.id) !== record) return;
      this.byId.delete(record.item.id);
      this.byCorrelation.delete(record.correlation);
      this.persist();
      this.remove(record.item.id, status);
    }, TERMINAL_KEEP_MS);
    record.removeTimer.unref();
  }

  private restore() {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as SavedRecord[];
      for (const value of saved) {
        if (!value || typeof value.correlation !== 'string' || !value.item || typeof value.item.id !== 'string') continue;
        if (terminal(value.item.status)) continue;
        const unsupported = value.item.kind === 'unsupported';
        const item = {
          ...value.item,
          status: unsupported ? 'error' as const : 'pending' as const,
          error: unsupported ? value.item.error : undefined,
          updatedAt: Date.now(),
          version: value.item.version + 1,
        };
        const record: RecordState = { correlation: value.correlation, item, waiters: new Set(), awaitProviderAck: value.awaitProviderAck === true };
        this.byId.set(item.id, record);
        this.byCorrelation.set(record.correlation, record);
        this.arm(record);
      }
    } catch {
      // no saved requests, or a torn file: providers will retry their callbacks
    }
  }

  private persist() {
    try {
      const saved: SavedRecord[] = [...this.byId.values()].filter((r) => !terminal(r.item.status)).map((r) => ({ correlation: r.correlation, item: r.item, ...(r.awaitProviderAck ? { awaitProviderAck: true } : {}) }));
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // a disk issue must not take down active provider callbacks
    }
  }

  private audit(item: PendingInteraction, decision: string, by: { id: string; name: string }) {
    try {
      appendFileSync(this.auditFile, `${JSON.stringify({ request: item.id, decision: safeInteractionText(decision, 128), at: Date.now(), worker: item.workerId, provider: item.provider, by: safeInteractionText(by.name, 100), client: by.id })}\n`, { mode: 0o600 });
    } catch {
      // audit failure does not strand the agent
    }
  }
}
