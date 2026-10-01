import './environment-summary.css';
import { DESK_BY_ID } from '../../shared/layout';
import type { GhPull, GhState, ProjectInfo, QueueState, WorkerInfo } from '../../shared/protocol';
import { store, type Topic } from '../state';
import { h, openModal, STATUS_LABEL, timeAgo, type Modal } from './dom';

interface SummaryPull {
  number: number;
  title?: string;
  state?: string;
  checks?: GhPull['checks'];
}

export interface EnvironmentSnapshot {
  project: ProjectInfo | null;
  floorName: string;
  floorRepo?: string;
  workers: WorkerInfo[];
  tasks: QueueState['tasks'];
  pulls: SummaryPull[];
  active: number;
  attention: number;
  queued: number;
  running: number;
  queueLimit: number;
  people: number;
  github: { loading: boolean; errors: string[]; fetchedAt: number };
}

interface EnvironmentSource {
  project: ProjectInfo | null;
  floor: string | null;
  floors: typeof store.floors;
  workers: Map<string, WorkerInfo>;
  queue: QueueState;
  pulls: GhState<GhPull>;
  issues: typeof store.issues;
  peers: typeof store.peers;
}

/** The floor data already delivered to the Office client, reduced to what the summary window shows. */
export function environmentSnapshot(source: EnvironmentSource = store): EnvironmentSnapshot {
  const workers = [...source.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
  const tasks = [...source.queue.tasks].sort((a, b) => b.addedAt - a.addedAt);
  const associated = new Map<number, SummaryPull>();
  const add = (pr: { number: number; title?: string; state?: string } | undefined) => {
    if (pr) associated.set(pr.number, { ...associated.get(pr.number), ...pr });
  };
  for (const worker of workers) {
    add(worker.pr);
    for (const repo of worker.repos ?? []) add(repo.pr);
  }
  for (const task of tasks) add(task.pr);
  for (const pull of source.pulls.items) {
    if (associated.has(pull.number)) associated.set(pull.number, { number: pull.number, title: pull.title, state: pull.state, checks: pull.checks });
  }
  const errors = [...new Set([source.issues.error, source.pulls.error].filter((error): error is string => !!error))];
  const floor = source.floors.find((item) => item.id === source.floor);
  return {
    project: source.project,
    floorName: floor?.name ?? source.project?.name ?? 'Agent Office',
    floorRepo: floor?.repo,
    workers,
    tasks,
    pulls: [...associated.values()].sort((a, b) => b.number - a.number),
    active: workers.filter((worker) => worker.status === 'starting' || worker.status === 'working').length,
    attention: workers.filter((worker) => worker.status === 'needs_input').length,
    queued: tasks.filter((task) => task.status === 'queued').length,
    running: tasks.filter((task) => task.status === 'running').length,
    queueLimit: source.queue.maxWorkers,
    people: [...source.peers.values()].filter((peer) => (peer.floor ?? null) === source.floor).length,
    github: {
      loading: source.issues.loading || source.pulls.loading,
      errors,
      fetchedAt: Math.max(source.issues.fetchedAt, source.pulls.fetchedAt),
    },
  };
}

let current: { modal: Modal; trigger: HTMLElement } | null = null;

/** Opens the native summary window, or closes it when its adjacent floor button is pressed again. */
export function toggleEnvironmentSummary(trigger: HTMLElement, refresh: () => void): void {
  if (current) {
    current.modal.close();
    return;
  }

  const title = h('h2', { id: 'environment-summary-title' }, '📊 Environment summary');
  const status = h('span.environment-live', { role: 'status', 'aria-live': 'polite' });
  const refreshButton = h('button.btn.environment-refresh', { type: 'button', 'aria-label': 'Refresh GitHub data' }, h('span', { 'aria-hidden': 'true' }, '↻'), h('span.refresh-label', {}, 'Refresh'));
  const body = h('div.body.environment-body');
  const el = h('section.modal.environment-panel', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'environment-summary-title' }, h('header', {}, title, status, refreshButton), body);
  const topics: Topic[] = ['workers', 'queue', 'issues', 'pulls', 'project', 'floor', 'floors', 'peers'];

  const render = () => {
    const data = environmentSnapshot();
    title.textContent = `📊 ${data.floorName} summary`;
    status.className = `environment-live${data.attention || data.github.errors.length ? ' attention' : ''}`;
    status.textContent = data.github.loading ? 'Refreshing…' : data.github.errors.length ? 'Needs attention' : 'Live';
    refreshButton.toggleAttribute('disabled', data.github.loading);
    body.replaceChildren(renderOverview(data));
  };
  const offs = topics.map((topic) => store.on(topic, render));
  const modal = openModal(el, {
    backdropCloses: false,
    doing: '📊 reviewing the environment',
    onClose: () => {
      offs.forEach((off) => off());
      trigger.setAttribute('aria-expanded', 'false');
      if (current?.modal === modal) current = null;
      trigger.focus();
    },
  });
  modal.backdrop.classList.add('environment-backdrop');
  trigger.setAttribute('aria-expanded', 'true');
  current = { modal, trigger };
  refreshButton.addEventListener('click', () => {
    refresh();
    status.textContent = 'Refresh requested…';
  });
  render();
  el.querySelector<HTMLElement>('.close')?.focus();
}

function renderOverview(data: EnvironmentSnapshot): HTMLElement {
  if (!data.project) {
    return h('div.environment-empty.major', {}, h('span', { 'aria-hidden': 'true' }, '🏢'), h('strong', {}, 'No floor selected'), h('p', {}, 'Take the elevator to a project to see its live environment summary.'));
  }
  const workingMeta = data.attention ? `${data.attention} need attention` : 'Nobody needs attention';
  const githubState = data.github.loading ? h('div.environment-notice.loading', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), h('span', {}, 'Refreshing issues and pull requests…')) : data.github.errors.length ? h('div.environment-notice.error', { role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '!'), h('span', {}, h('strong', {}, 'GitHub data is unavailable'), h('small', {}, data.github.errors.join(' · ')))) : null;
  return h(
    'div.environment-content',
    {},
    h(
      'section.environment-hero',
      { 'aria-label': 'Floor status' },
      h('div', {}, h('span.environment-eyebrow', {}, 'Current floor'), h('h3', {}, data.floorName), h('p', {}, [data.floorRepo, data.project.branch && `branch ${data.project.branch}`].filter(Boolean).join(' · ') || 'Local project')),
      h('div.environment-signal', { 'aria-label': `${data.active} working, ${data.attention} need attention` }, h('strong', {}, String(data.active)), h('span', {}, 'working'), h('i'), h('strong', { class: data.attention ? 'attention' : '' }, String(data.attention)), h('span', {}, 'need attention')),
    ),
    h(
      'section.environment-metrics',
      { 'aria-label': 'Environment metrics' },
      metric(data.workers.length, 'Workers', `${data.workers.length - data.active} not working now`, 'info'),
      metric(data.active, 'Working now', workingMeta, 'accent'),
      metric(data.queued, 'Tasks waiting', `${data.running} running`, 'warn'),
      metric(data.pulls.length, 'Associated PRs', pullSummary(data.pulls), 'good'),
    ),
    githubState,
    h(
      'div.environment-grid',
      {},
      workersPanel(data),
      queuePanel(data),
      pullsPanel(data),
      detailsPanel(data),
    ),
  );
}

function metric(value: number, label: string, detail: string, tone: string): HTMLElement {
  return h('article.environment-metric', { class: `tone-${tone}` }, h('strong', {}, String(value)), h('h3', {}, label), h('p', {}, detail));
}

function workersPanel(data: EnvironmentSnapshot): HTMLElement {
  const content = data.workers.length
    ? h('ul.environment-list.workers', {}, ...data.workers.map((worker) => {
        const desk = DESK_BY_ID.get(worker.deskId);
        const work = worker.task?.name ?? worker.title ?? worker.prompt ?? 'No task described';
        const meta = [desk?.label ?? worker.deskId, worker.kind === 'shell' ? 'shell' : worker.provider, worker.model, worker.worktree?.branch].filter(Boolean).join(' · ');
        return h(
          'li',
          {},
          h('span.dot', { style: `background:${worker.color}` }),
          h('div.environment-item-main', {}, h('div.environment-item-title', {}, h('strong', {}, worker.name), h('span.pill', { class: worker.status }, STATUS_LABEL[worker.status] ?? worker.status)), h('p', {}, work), h('small', {}, meta)),
        );
      }))
    : empty('00', 'No workers on this floor', 'Its available desks are ready for work.');
  return panel('Workers', 'Live desks', content);
}

function queuePanel(data: EnvironmentSnapshot): HTMLElement {
  const columns = [
    { status: 'queued', label: 'Waiting' },
    { status: 'running', label: 'Running' },
    { status: 'done', label: 'Done' },
  ] as const;
  const content = h('div.environment-queue', {}, ...columns.map((column) => {
    const tasks = data.tasks.filter((task) => task.status === column.status).slice(0, 6);
    return h(
      'section',
      { 'aria-label': column.label },
      h('div.environment-column-head', {}, h('strong', {}, column.label), h('span', {}, String(data.tasks.filter((task) => task.status === column.status).length))),
      tasks.length ? h('ul', {}, ...tasks.map((task) => h('li', {}, h('small', {}, task.id.slice(0, 8)), h('strong', {}, task.title), h('span', {}, [task.workerName, task.branch, task.pr && `PR #${task.pr.number}`].filter(Boolean).join(' · ') || (task.status === 'queued' ? 'Waiting for a worker' : 'No worker details'))))) : h('p.environment-column-empty', {}, 'No tasks'),
    );
  }));
  return panel('Task queue', 'Workflow', content);
}

function pullsPanel(data: EnvironmentSnapshot): HTMLElement {
  let content: HTMLElement;
  if (data.github.loading && !data.pulls.length) content = h('div.environment-loading', { 'aria-busy': 'true' }, h('span.spinner', { 'aria-hidden': 'true' }), 'Loading pull requests…');
  else if (data.github.errors.length && !data.pulls.length) content = empty('!', 'Pull requests unavailable', 'The rest of the live floor data remains available.');
  else if (!data.pulls.length) content = empty('PR', 'No associated pull requests', 'Workers and queue tasks have not linked a pull request yet.');
  else content = h('ul.environment-list.pulls', {}, ...data.pulls.map((pull) => h('li', {}, h('span.environment-pr-number', {}, `#${pull.number}`), h('div.environment-item-main', {}, h('strong', {}, pull.title ?? 'Pull request'), h('small', {}, [pull.state?.toLowerCase(), pull.checks && `checks ${pull.checks}`].filter(Boolean).join(' · ') || 'State unavailable')))));
  return panel('Associated pull requests', 'Delivery', content);
}

function detailsPanel(data: EnvironmentSnapshot): HTMLElement {
  const updated = data.github.fetchedAt ? timeAgo(data.github.fetchedAt) : data.github.loading ? 'loading' : 'not available';
  const details = [
    ['Default agent', data.project?.defaultProvider ?? 'Unavailable'],
    ['Providers', data.project?.agentProviders.join(', ') || 'Unavailable'],
    ['People on floor', String(data.people)],
    ['Queue concurrency', data.queueLimit ? String(data.queueLimit) : 'Paused'],
    ['GitHub refreshed', updated],
    ['Data channel', 'Office WebSocket'],
  ];
  return panel('Environment', 'Runtime and sources', h('dl.environment-details', {}, ...details.flatMap(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])), h('p.environment-security', {}, 'Uses the Office’s existing authenticated connection. No worker token or environment variable is exposed to this window.'));
}

function panel(title: string, eyebrow: string, ...children: HTMLElement[]): HTMLElement {
  return h('section.environment-card', {}, h('header', {}, h('div', {}, h('span.environment-eyebrow', {}, eyebrow), h('h3', {}, title))), ...children);
}

function empty(mark: string, title: string, detail: string): HTMLElement {
  return h('div.environment-empty', {}, h('span', { 'aria-hidden': 'true' }, mark), h('strong', {}, title), h('p', {}, detail));
}

function pullSummary(pulls: SummaryPull[]): string {
  const open = pulls.filter((pull) => pull.state?.toUpperCase() === 'OPEN').length;
  const merged = pulls.filter((pull) => pull.state?.toUpperCase() === 'MERGED').length;
  return `${open} open · ${merged} merged`;
}
