import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { JSDOM } from 'jsdom';
import { ordinarySidebar, CodexSidebar, installImportedSidebar } from '../src/sidebar.js';
import { filterCatalog, catalogProjects } from '../src/presentation.js';

const store = value => ({ getSnapshot: () => value, subscribe() { return () => {}; } });
const imported = i => ({ id: `import-${i}`, threadId: `codex-${i}`, title: `历史对话 ${i}`, projectKey: '/original/project',
  projectTitle: '原项目', projectPath: '/original/project', originalCwd: '/original/project', archived: false, metadataOnly: false });

test('import grouping preserves unrelated workspaces, manual conversations and mixed accounts', () => {
  const items = [imported(1), imported(2)];
  const workspaces = [
    { workspaceId: 'imported', sessionIds: ['import-1'], path: '/a' },
    { workspaceId: 'mixed', sessionIds: ['manual', 'import-2'], path: '/b' },
    { workspaceId: 'empty-manual', sessionIds: [], path: '/c' },
  ];
  const result = ordinarySidebar(workspaces, { ids: ['import-1', 'import-2', 'manual', 'loose'] }, items);
  assert.deepEqual(result.groups.map(g => g.workspaceId), ['mixed', 'empty-manual']);
  assert.deepEqual(result.groups[0].sessionIds, ['manual']); assert.deepEqual(result.loose, ['loose']);
  assert.deepEqual(workspaces[1].sessionIds, ['manual', 'import-2']);
});

async function mount(t, options = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://local' });
  const prior = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.querySelector('#app'));
  const items = Array.from({ length: 1378 }, (_, i) => imported(i));
  const calls = [];
  const sessionSource = store({ ids: ['manual'], byId: { manual: { id: 'manual', displayTitle: '原有手动对话', blank: false } } });
  const workspaceSource = store({ items: [{ workspaceId: 'native-imported', title: '原项目', sessionIds: items.map(i => i.id), path: '/original/project' },
    { workspaceId: 'normal', title: '原有工作区', sessionIds: ['manual'], path: '/manual' }], archivedSessionIds: [] });
  const props = { sessionSource, workspaceSource, revision: { ...store(0), refresh() { calls.push('refresh'); } },
    filterCatalog, catalogProjects, async loadCatalog() { return { items, total: items.length, loading: false, processed: items.length, errors: [] }; },
    async refreshSessions() { calls.push('refreshSessions'); }, openSession(id) { calls.push(['open', id]); }, nativeSidebar() { calls.push('native'); }, ...options };
  await React.act(async () => { root.render(React.createElement(CodexSidebar, props)); });
  t.after(async () => { await React.act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, prior); });
  return { doc: dom.window.document, dom, calls, items };
}

test('new sidebar exposes all imported projects under one folder without waiting for native list refresh', async t => {
  const view = await mount(t);
  assert.match(view.doc.body.textContent, /Codex 导入目录1378/);
  assert.equal(view.doc.querySelectorAll('.codex-sidebar-imports .codex-sidebar-project').length, 1);
  assert.ok(view.calls.includes('refreshSessions'));
  assert.equal(view.doc.querySelector('.codex-sidebar-session'), null);
  const project = view.doc.querySelector('.codex-sidebar-project>button');
  await React.act(async () => project.click());
  assert.equal(view.doc.querySelectorAll('.codex-sidebar-session').length, 20);
  const row = view.doc.querySelector('.codex-sidebar-session'); await React.act(async () => row.click());
  assert.deepEqual(view.calls.find(c => Array.isArray(c)), ['open', 'import-0']);
  const more = view.doc.querySelector('.codex-sidebar-more'); await React.act(async () => more.click());
  assert.equal(view.doc.querySelectorAll('.codex-sidebar-session').length, 70);
  const root = view.doc.querySelector('.codex-sidebar-root'); await React.act(async () => root.click());
  assert.equal(view.doc.querySelector('.codex-sidebar-imports'), null);
  assert.match(view.doc.body.textContent, /原有工作区/);
});

test('sidebar search reaches the final imported record before paging and does not activate all agents', async t => {
  const view = await mount(t);
  const input = view.doc.querySelector('input');
  await React.act(async () => Simulate.change(input, { target: { value: '历史对话 1377' } }));
  const rows = view.doc.querySelectorAll('.codex-sidebar-session');
  assert.equal(rows.length, 1); assert.match(rows[0].textContent, /1377/);
  assert.equal(view.calls.filter(c => Array.isArray(c)).length, 0);
  await React.act(async () => rows[0].click());
  assert.deepEqual(view.calls.find(c => Array.isArray(c)), ['open', 'import-1377']);
});

test('sidebar shows readable load failures and allows native workspace management', async t => {
  const view = await mount(t, { async loadCatalog() { throw new Error('连接暂时中断'); } });
  assert.match(view.doc.querySelector('[role="alert"]').textContent, /连接暂时中断/);
  const native = [...view.doc.querySelectorAll('button')].find(b => b.textContent === '原生侧栏');
  await React.act(async () => native.click()); assert.ok(view.calls.includes('native'));
});

test('sidebar uses the public slot override and restoring native view removes only the presentation override', () => {
  let injected, registration, released = 0; const oldStorage = globalThis.localStorage;
  const values = new Map(); globalThis.localStorage = { getItem: key => values.get(key), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  try {
    const ctx = { sessions: { list: store({}) }, workspaces: { list: store({}) }, slots: {
      entries() { return []; }, inject(name, fn) { assert.equal(name, 'sidebar.workspaces'); injected = fn; },
      register(options, component) { registration = { options, component }; return () => { released++; }; },
    } };
    const control = installImportedSidebar(ctx, {}); const dispose = injected();
    assert.equal(registration.options.priority, -20); assert.equal(registration.component, CodexSidebar);
    assert.equal(registration.options.children, undefined);
    registration.options.inject().nativeSidebar(); assert.equal(released, 1);
    assert.equal(values.get('codex-import.native-sidebar'), 'true');
    control.enable(); assert.equal(values.has('codex-import.native-sidebar'), false);
    dispose(); assert.equal(released, 2);
  } finally { globalThis.localStorage = oldStorage; }
});
