import type { ClientMsg, PendingInteraction, PendingInteractionResponse, ServerMsg } from '../../shared/protocol';
import { h, timeAgo } from './dom';
import './interactions.css';

type Send = (message: ClientMsg) => void;

const ACTIVE = new Set(['pending', 'sending', 'error']);

function actionable(item: PendingInteraction): boolean {
  return item.kind !== 'unsupported' && ACTIVE.has(item.status);
}
const STATUS: Record<PendingInteraction['status'], string> = {
  pending: 'Waiting for you',
  sending: 'Sending…',
  error: 'Could not send',
  resolved: 'Resolved',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const KIND: Record<PendingInteraction['kind'], string> = {
  approval: 'Approval',
  permission: 'Permission',
  question: 'Question',
  confirmation: 'Confirmation',
  unsupported: 'Terminal fallback',
};

const PROVIDER: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', dsh: 'DeepSeek Harness', grok: 'Grok', muse: 'Muse', pi: 'Pi', custom: 'Custom' };

function priority(item: PendingInteraction): number {
  if (!actionable(item)) return 3;
  if (item.risk || item.options.some((o) => o.risk === 'danger')) return 0;
  if (item.status === 'error') return 1;
  return 2;
}

/** Stable order: blocking/high-risk first, then oldest, then server id. */
export function interactionOrder(items: Iterable<PendingInteraction>): PendingInteraction[] {
  return [...items].sort((a, b) => priority(a) - priority(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Bottom interaction center shared by the 3D and 2D clients. */
export class InteractionDock {
  private readonly items = new Map<string, PendingInteraction>();
  private readonly lastResponse = new Map<string, PendingInteractionResponse>();
  private expanded = false;
  private selected?: string;
  private welcomed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly send: Send,
  ) {
    root.classList.add('interaction-center');
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.expanded) return;
      this.expanded = false;
      this.render();
    }, true);
    this.render();
  }

  handle(message: ServerMsg) {
    if (message.t === 'welcome') {
      this.items.clear();
      for (const item of message.interactions) this.items.set(item.id, item);
      this.welcomed = true;
      this.render();
      return;
    }
    if (message.t === 'interaction.upsert') {
      const was = this.items.get(message.interaction.id);
      this.items.set(message.interaction.id, message.interaction);
      if (this.welcomed && (!was || !ACTIVE.has(was.status)) && message.interaction.status === 'pending') this.announce(`${message.interaction.workerName} needs your ${KIND[message.interaction.kind].toLowerCase()}`);
      this.render();
      return;
    }
    if (message.t === 'interaction.remove') {
      this.items.delete(message.id);
      this.lastResponse.delete(message.id);
      if (this.selected === message.id) this.selected = undefined;
      this.render();
    }
  }

  private render() {
    const ordered = interactionOrder(this.items.values());
    const active = ordered.filter(actionable).length;
    if (!this.selected || !this.items.has(this.selected)) this.selected = ordered[0]?.id;
    const toggle = h(
      'button.btn.interaction-toggle',
      {
        type: 'button',
        'aria-expanded': String(this.expanded),
        'aria-controls': 'interaction-panel',
        'aria-label': active ? `${active} pending agent interaction${active === 1 ? '' : 's'}` : 'Agent interactions: none pending',
        onclick: () => {
          this.expanded = !this.expanded;
          this.render();
          if (this.expanded) requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.interaction-panel-title')?.focus());
        },
      },
      h('span.interaction-icon', { 'aria-hidden': 'true' }, active ? '🙋' : '✓'),
      h('span.interaction-toggle-label', {}, active ? 'Needs you' : 'No pending decisions'),
      ...(active ? [h('span.interaction-badge', { 'aria-hidden': 'true' }, active)] : []),
      h('span.interaction-chevron', { 'aria-hidden': 'true' }, this.expanded ? '▾' : '▴'),
    );
    const live = h('span.sr-only', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-interaction-live': true });
    this.root.replaceChildren(toggle, live, ...(this.expanded ? [this.panel(ordered)] : []));
    this.root.classList.toggle('has-pending', active > 0);
  }

  private panel(items: PendingInteraction[]): HTMLElement {
    const selected = items.find((item) => item.id === this.selected);
    const list = h('div.interaction-list', { role: 'list', 'aria-label': 'Agent interaction queue' });
    if (!items.length) list.append(h('div.interaction-empty', {}, h('strong', {}, 'Nothing needs a decision'), h('span', {}, 'New structured requests from agents will appear here.')));
    for (const item of items) {
      const dangerous = !!item.risk || item.options.some((o) => o.risk === 'danger');
      list.append(h(
        'button.interaction-row',
        {
          type: 'button',
          role: 'listitem',
          class: `${this.selected === item.id ? 'selected' : ''} ${dangerous ? 'danger' : ''}`,
          'aria-pressed': String(this.selected === item.id),
          onclick: () => {
            this.selected = item.id;
            this.render();
          },
        },
        h('span.interaction-row-top', {}, h('strong', {}, item.workerName), h('span.interaction-state', { class: item.status }, STATUS[item.status])),
        h('span.interaction-row-title', {}, item.title),
        h('span.interaction-row-meta', {}, `${item.floorName} · ${PROVIDER[item.provider] ?? item.provider} · ${KIND[item.kind]} · ${timeAgo(item.createdAt)}`),
      ));
    }
    return h(
      'section.interaction-panel',
      { id: 'interaction-panel', 'aria-label': 'Agent interaction center' },
      h('header.interaction-panel-head', {}, h('h2.interaction-panel-title', { tabindex: '-1' }, 'Agent interactions'), h('span', {}, items.length ? `${items.length} recent` : 'Queue empty')),
      h('div.interaction-layout', {}, list, selected ? this.detail(selected) : h('div.interaction-detail.interaction-detail-empty', {}, 'Select a request to review it.')),
    );
  }

  private detail(item: PendingInteraction): HTMLElement {
    const disabled = item.status === 'sending' || !ACTIVE.has(item.status) || item.kind === 'unsupported';
    const body = h(
      'article.interaction-detail',
      { 'aria-labelledby': `interaction-title-${item.id}` },
      h('div.interaction-detail-scroll', {},
        h('div.interaction-kicker', {}, `${KIND[item.kind]} · ${PROVIDER[item.provider] ?? item.provider}`),
        h('h3', { id: `interaction-title-${item.id}` }, item.title),
        h('p.interaction-origin', {}, `${item.workerName} · ${item.floorName}${item.task ? ` · ${item.task}` : ''} · ${timeAgo(item.createdAt)}`),
        h('p.interaction-prompt', {}, item.prompt),
        ...(item.description ? [this.fact('Context', item.description)] : []),
        ...(item.resource ? [this.fact('Command or resource', item.resource, true)] : []),
        ...(item.impact ? [this.fact('Impact', item.impact)] : []),
        ...(item.risk ? [this.fact('Risk', item.risk, false, 'danger')] : []),
        ...(item.unsupportedReason ? [this.fact('Why the terminal is required', item.unsupportedReason)] : []),
        ...(item.error ? [this.fact('Error', item.error, false, 'danger')] : []),
        ...(item.fields?.length ? [this.fields(item, disabled)] : []),
      ),
      this.actions(item, disabled),
    );
    return body;
  }

  private fact(label: string, value: string, code = false, kind = ''): HTMLElement {
    return h('div.interaction-fact', { class: kind }, h('strong', {}, label), code ? h('code', {}, value) : h('p', {}, value));
  }

  private fields(item: PendingInteraction, disabled: boolean): HTMLElement {
    const form = h('div.interaction-fields', { id: `interaction-fields-${item.id}` });
    for (const field of item.fields ?? []) {
      const set = h('fieldset', { 'data-field': field.id, disabled });
      set.append(h('legend', {}, field.label), h('p', {}, field.prompt));
      for (const option of field.options ?? []) {
        const id = `${item.id}-${field.id}-${Math.random().toString(36).slice(2)}`;
        const input = h('input', { id, type: field.multiple ? 'checkbox' : 'radio', name: `${item.id}-${field.id}`, value: option.label, disabled });
        set.append(h('label.interaction-choice', { for: id }, input, h('span', {}, h('strong', {}, option.label), ...(option.description ? [h('small', {}, option.description)] : []))));
      }
      if (field.text) set.append(h('label.interaction-free', {}, h('span', {}, field.options?.length ? 'Other answer' : 'Answer'), h(field.secret ? 'input' : 'textarea', { type: field.secret ? 'password' : undefined, 'data-free': true, rows: field.secret ? undefined : 3, autocomplete: field.secret ? 'off' : undefined, disabled })));
      form.append(set);
    }
    return form;
  }

  private actions(item: PendingInteraction, disabled: boolean): HTMLElement {
    const row = h('footer.interaction-actions');
    if (item.kind === 'unsupported') {
      row.append(h('span.interaction-note', {}, 'Use the worker terminal for this provider request.'));
      return row;
    }
    if (!ACTIVE.has(item.status)) {
      row.append(h('span.interaction-note', {}, STATUS[item.status]));
      return row;
    }
    if (item.status === 'error' && this.lastResponse.has(item.id)) row.append(this.actionButton(item, 'Retry', this.lastResponse.get(item.id)!, 'caution', false));
    for (const option of item.options) {
      if (item.fields?.length && option.intent === 'approve') {
        row.append(h('button.btn', { type: 'button', class: 'primary', disabled, onclick: () => this.submitFields(item, option.id) }, item.status === 'sending' ? 'Sending…' : option.label));
      } else row.append(this.actionButton(item, option.label, { optionId: option.id }, option.risk, disabled));
    }
    return row;
  }

  private actionButton(item: PendingInteraction, label: string, response: PendingInteractionResponse, risk: string | undefined, disabled: boolean): HTMLButtonElement {
    return h('button.btn', { type: 'button', class: risk === 'danger' ? 'danger' : response.optionId && item.options.find((o) => o.id === response.optionId)?.intent === 'approve' ? 'primary' : '', disabled, onclick: () => this.resolve(item, response) }, label);
  }

  private submitFields(item: PendingInteraction, optionId: string) {
    const container = this.root.querySelector(`#interaction-fields-${CSS.escape(item.id)}`);
    if (!container) return;
    const answers: Record<string, string[]> = {};
    for (const field of item.fields ?? []) {
      const set = container.querySelector<HTMLElement>(`[data-field="${CSS.escape(field.id)}"]`);
      if (!set) return;
      const selected = [...set.querySelectorAll<HTMLInputElement>('input[type=radio]:checked,input[type=checkbox]:checked')].map((input) => input.value);
      const free = set.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-free]')?.value.trim();
      answers[field.id] = free ? (field.multiple ? [...selected, free] : [free]) : selected;
      if (!answers[field.id].length) {
        set.querySelector<HTMLElement>('input,textarea')?.focus();
        set.classList.add('invalid');
        return;
      }
    }
    this.resolve(item, { optionId, answers });
  }

  private resolve(item: PendingInteraction, response: PendingInteractionResponse) {
    if (!ACTIVE.has(item.status) || item.status === 'sending') return;
    this.lastResponse.set(item.id, response);
    this.items.set(item.id, { ...item, status: 'sending' });
    this.send({ t: 'interaction.resolve', id: item.id, version: item.version, response });
    this.render();
  }

  private announce(text: string) {
    requestAnimationFrame(() => {
      const live = this.root.querySelector<HTMLElement>('[data-interaction-live]');
      if (live) live.textContent = text;
    });
  }
}
