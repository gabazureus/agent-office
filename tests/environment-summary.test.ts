import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import type { PeerInfo, WorkerInfo } from '../src/shared/protocol';

function installDom() {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="modal-root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
  });
  return { document, window };
}

test('summary button is immediately beside the floor control and never routes through Services', async () => {
  const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  const { document } = parseHTML(html);
  const trigger = document.getElementById('environment-summary');
  assert.ok(trigger);
  assert.equal(trigger.previousElementSibling?.id, 'project');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');

  const source = readFileSync(new URL('../src/client/ui/environment-summary.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /openServices|serviceUrl|location\.assign|window\.open/);
});

test('summary trigger has no decorative border but keeps a keyboard-only focus ring', () => {
  const css = readFileSync(new URL('../src/client/ui/environment-summary.css', import.meta.url), 'utf8');
  const base = css.match(/\.btn\.environment-summary-trigger\s*\{([^}]*)\}/)?.[1] ?? '';
  const pointerFocus = css.match(/\.btn\.environment-summary-trigger:focus\s*\{([^}]*)\}/)?.[1] ?? '';
  const keyboardFocus = css.match(/\.btn\.environment-summary-trigger:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
  const pressed = css.match(/\.btn\.environment-summary-trigger:active,\s*\.btn\.environment-summary-trigger\[aria-expanded=true\]\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(base, /border:\s*0\s*;/);
  assert.match(base, /box-shadow:\s*none\s*;/);
  assert.match(pointerFocus, /outline:\s*none\s*;/);
  assert.match(keyboardFocus, /outline:\s*3px solid var\(--accent\)\s*;/);
  assert.match(pressed, /box-shadow:\s*none\s*;/);
});

test('summary opens and closes from its button, close control and Escape', async () => {
  const { document, window } = installDom();
  const [{ toggleEnvironmentSummary }, { store }] = await Promise.all([import('../src/client/ui/environment-summary'), import('../src/client/state')]);
  store.project = { name: 'sandbox', branch: 'main', dir: '/redacted', agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] };
  store.floor = 'sandbox';
  store.floors = [{ id: 'sandbox', name: 'sandbox', dir: '/redacted', palette: 0, addedBy: 'test', addedAt: 0, workers: 0, busy: 0, waiting: 0, people: 1, wing: 0 }];
  store.workers = new Map();
  store.queue = { tasks: [], maxWorkers: 2 };
  store.pulls = { items: [], fetchedAt: Date.now(), loading: false };
  store.issues = { items: [], fetchedAt: Date.now(), loading: false };
  store.peers = new Map<string, PeerInfo>();

  const trigger = document.createElement('button');
  trigger.id = 'environment-summary';
  trigger.setAttribute('aria-expanded', 'false');
  document.body.append(trigger);
  trigger.addEventListener('click', () => toggleEnvironmentSummary(trigger, () => undefined));

  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.match(document.querySelector('.environment-panel')?.textContent ?? '', /sandbox summary/);
  assert.match(document.querySelector('.environment-panel')?.textContent ?? '', /No workers on this floor/);

  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.environment-panel'), null);

  trigger.click();
  document.querySelector<HTMLElement>('.environment-panel .close')?.click();
  assert.equal(document.querySelector('.environment-panel'), null);

  trigger.click();
  const escape = new window.Event('keydown', { bubbles: true, cancelable: true }) as Event & { key: string };
  escape.key = 'Escape';
  window.dispatchEvent(escape);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.environment-panel'), null);
});

test('summary model exposes live, loading, error and associated-data states', async () => {
  installDom();
  const { environmentSnapshot } = await import('../src/client/ui/environment-summary');
  const worker = {
    id: 'worker-1', kind: 'agent', provider: 'codex', deskId: 'desk-1', name: 'Sprocket', color: '#fff', status: 'working', acked: false, createdBy: 'test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], pr: { number: 3, url: 'https://example.test/3' },
  } as WorkerInfo;
  const state = {
    project: { name: 'sandbox', branch: 'main', dir: '/redacted', agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] },
    floor: 'sandbox',
    floors: [{ id: 'sandbox', name: 'sandbox', dir: '/redacted', palette: 0, addedBy: 'test', addedAt: 0, workers: 1, busy: 1, waiting: 0, people: 1, wing: 0 }],
    workers: new Map([[worker.id, worker]]),
    queue: { maxWorkers: 2, tasks: [{ id: 'task-1', title: 'Fix summary', prompt: 'Fix it', addedBy: 'test', addedAt: 1, status: 'running' as const, workerId: worker.id, pr: { number: 3, url: 'https://example.test/3', state: 'OPEN', title: 'Native summary' } }] },
    pulls: { items: [{ number: 3, title: 'Native summary', state: 'OPEN', isDraft: false, url: 'https://example.test/3', author: 'test', labels: [], reviewDecision: '', headRefName: 'fix', baseRefName: 'main', createdAt: '', updatedAt: '', additions: 1, deletions: 0, checks: 'pass' as const, body: '', closes: [] }], fetchedAt: 20, loading: true, error: 'GitHub is unavailable' },
    issues: { items: [], fetchedAt: 10, loading: false },
    peers: new Map<string, PeerInfo>(),
  };

  const result = environmentSnapshot(state);
  assert.equal(result.active, 1);
  assert.equal(result.running, 1);
  assert.equal(result.pulls.length, 1);
  assert.equal(result.pulls[0]?.title, 'Native summary');
  assert.equal(result.github.loading, true);
  assert.deepEqual(result.github.errors, ['GitHub is unavailable']);
});
