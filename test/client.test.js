import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { apply, latestProgress } from '../src/client.js';

class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.style = {}; this.children = []; this.attributes = {}; this.open = false; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  showModal() { this.open = true; this.shown = (this.shown || 0) + 1; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) { const match = find(child, predicate); if (match) return match; }
}

function mount(t, overrides = {}) {
  const prior = globalThis.document;
  const body = new Element('body');
  globalThis.document = { body, head: new Element('head'), createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = prior; });
  let onResult, cleanup, listener;
  const state = { rows: {}, observed: {} };
  const calls = [];
  const jobs = {
    state: { getSnapshot: () => state, subscribe(fn) { listener = fn; return () => { listener = undefined; calls.push('unsubscribe'); }; } },
    watchRows(id) { calls.push(['watch', id]); return () => calls.push('unwatch'); },
    observe(owner, id) { calls.push(['observe', owner, id]); return () => calls.push('unobserve'); },
    async kill(sessionId, jobId) { calls.push(['kill', sessionId, jobId]); return { ok: true, value: { outcome: 'requested' } }; },
  };
  const remote = { commands: { async execute(...args) { calls.push(['execute', ...args]); return { ok: true, value: { result: { kind: 'success', text: receipt.replace('导入', '清理').replace('abcdef1234', 'fedcba4321') } } }; } } };
  apply({ jobs, remote, slots: { inject() {} }, uiConversation: { events: { register() {} }, userText: { register() {} } }, effect(fn) { cleanup = fn(); }, on(name, fn) { assert.equal(name, 'command/executed'); onResult = fn; }, ...overrides });
  t.after(() => cleanup());
  const dialog = body.children[0];
  return { dialog, state, calls, tick: () => listener?.(), result: (...args) => onResult(...args), dispose: () => cleanup(),
    labelled: label => find(dialog, node => node.attributes['aria-label'] === label),
    heading: dialog.children[0], cancel: dialog.children.at(-1).children[0], close: dialog.children.at(-1).children[1] };
}

const receipt = 'Codex 导入任务\n任务编号：codex-import-abcdef1234\n正在开始';

test('command-only sessions show successful preview receipts and safe errors', t => {
  const view = mount(t);
  view.result('s', 'other-command', { kind: 'success', text: 'ignore' });
  assert.equal(view.dialog.open, false);
  view.result('s', 'codex-import', { kind: 'success', text: '会话: 1378；失败: 0' });
  assert.equal(view.dialog.open, true);
  assert.equal(view.labelled('导入详细结果').textContent, '会话: 1378；失败: 0');
  assert.equal(view.close.focused, true);
  view.close.dispatchEvent(new Event('click')); assert.equal(view.dialog.open, false);
  view.result('s', 'codex-import', { kind: 'error', text: '<script>never execute</script>' });
  assert.equal(view.heading.textContent, 'Codex 导入未完成');
  assert.equal(view.labelled('导入详细结果').textContent, '<script>never execute</script>');
});

test('running jobs show real counts and can continue in the background, reopen, and finish', t => {
  const view = mount(t);
  view.result('s', 'codex-import', { kind: 'success', text: receipt });
  assert.equal(view.dialog.open, true);
  assert.equal(view.close.textContent, '后台运行');
  assert.equal(view.cancel.hidden, false);
  view.state.rows.s = [{ id: 'codex-import-abcdef1234', status: 'running', startedAt: Date.now() }];
  const data = { phase: 'writing', total: 10, processed: 4, imported: 3, skipped: 1, recovered: 0, failed: 0, metadataOnly: 1, currentTitle: '中文会话' };
  view.state.observed['codex-import-abcdef1234'] = { text: `${JSON.stringify(data)}\n` };
  view.tick();
  assert.equal(view.labelled('导入进度').value, 4);
  assert.match(view.labelled('导入统计').textContent, /4 \/ 10（40%）/);
  assert.match(view.labelled('当前会话').textContent, /中文会话/);
  view.close.dispatchEvent(new Event('click'));
  assert.equal(view.dialog.open, false); assert.ok(!view.calls.includes('unobserve'));
  view.result('s', 'codex-import', { kind: 'success', text: receipt });
  assert.equal(view.dialog.open, true);
  view.state.rows.s[0].status = 'completed';
  view.state.observed['codex-import-abcdef1234'].text += JSON.stringify({ ...data, phase: 'completed', processed: 10, text: '全部导入完成' }) + '\n';
  view.tick();
  assert.equal(view.heading.textContent, '导入完成'); assert.equal(view.cancel.hidden, true);
  assert.equal(view.labelled('导入详细结果').textContent, '全部导入完成');
  view.close.dispatchEvent(new Event('click')); assert.ok(view.calls.includes('unobserve'));
  view.result('s', 'codex-import', { kind: 'success', text: '新的预览结果' });
  assert.equal(view.labelled('导入详细结果').textContent, '新的预览结果');
});

test('cancel requests stop through Harness job controls without discarding completed work', async t => {
  const view = mount(t);
  view.result('s', 'codex-import', { kind: 'success', text: receipt });
  view.cancel.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(view.calls.some(call => Array.isArray(call) && call[0] === 'kill' && call[2] === 'codex-import-abcdef1234'));
  assert.match(view.heading.textContent, /取消/);
  view.state.rows.s = [{ id: 'codex-import-abcdef1234', status: 'killed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify({ phase: 'cancelled', processed: 2, total: 10, text: '已完成的会话会保留' }) + '\n' };
  view.tick();
  assert.equal(view.heading.textContent, '已取消');
  assert.equal(view.labelled('导入详细结果').textContent, '已完成的会话会保留');
});

test('progress parsing tolerates retained tails and malformed older lines', () => {
  assert.equal(latestProgress('truncated\nnot-json\n' + JSON.stringify({ phase: 'reading', processed: 8 }) + '\n').processed, 8);
  assert.equal(latestProgress('broken'), undefined);
});

test('the browser artifact registers the Harness factory with job dependencies', async () => {
  let registration;
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  assert.equal(registration.id, 'dsh-plugin-codex-import');
  const exports = registration.factory(() => React); assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['commandUi', 'jobs', 'remote', 'remote.commands', 'slots', 'uiConversation', 'sessions', 'workspaces', 'uiWorkspace', 'layout']);
});


test('cleanup preview requires a typed count and sends the chosen continuation policy', async t => {
  const view = mount(t);
  view.result('s', 'codex-import', { kind: 'success', text: receipt.replace('导入', '清理') });
  view.state.rows.s = [{ id: 'codex-import-abcdef1234', status: 'completed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify({ mode: 'delete-plan', phase: 'completed', processed: 3, total: 3,
    proposal: { token: 'one-time-plan', count: 3, plainCount: 2, continuedCount: 1 }, text: '未删除任何内容' }) + '\n' };
  view.tick();
  const choice = view.labelled('同时删除包含 Harness 新增续聊的导入副本');
  const input = view.labelled('输入删除确认文字');
  const button = find(view.dialog, node => node.textContent === '确认删除 Harness 副本');
  assert.equal(view.heading.textContent, '删除前确认');
  assert.equal(view.labelled('删除确认').hidden, false); assert.equal(choice.checked, false);
  assert.match(view.labelled('删除确认说明').textContent, /删除 2 条会话/);
  assert.equal(button.disabled, true);
  input.value = '删除 2 条会话'; input.dispatchEvent(new Event('input')); assert.equal(button.disabled, false);
  choice.checked = true; choice.dispatchEvent(new Event('change'));
  assert.equal(button.disabled, true); assert.match(view.labelled('删除确认说明').textContent, /删除 3 条会话/);
  button.dispatchEvent(new Event('click')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.calls.filter(call => call[0] === 'execute').length, 0);
  input.value = '删除 3 条会话'; input.dispatchEvent(new Event('input')); assert.equal(button.disabled, false);
  button.dispatchEvent(new Event('click')); await new Promise(resolve => setImmediate(resolve));
  const execution = view.calls.find(call => call[0] === 'execute');
  assert.equal(execution[1], 's');
  assert.deepEqual(JSON.parse(execution[2].replace('/codex-import delete-confirm ', '')), {
    token: 'one-time-plan', includeContinued: true, confirmation: '删除 3 条会话',
  });
  assert.equal(view.labelled('删除确认').hidden, true);
});

test('preview opens immediately, never auto imports, and confirmation follows the new import job', async t => {
  const view = mount(t);
  const previewReceipt = receipt.replace('导入任务', '预览任务');
  view.result('owner', 'codex-import', { kind: 'success', text: previewReceipt });
  assert.equal(view.heading.textContent, '正在预览 Codex 对话');
  assert.equal(view.cancel.textContent, '取消预览');
  const data = { mode: 'preview', phase: 'completed', processed: 3, total: 3, withBody: 2, metadataOnly: 1,
    importProposal: { token: 'reviewed', expiresAt: Date.now() + 100000, count: 3, withBody: 2, metadataOnly: 1,
      sourceHome: '/source', destinationPath: '/target', workspaceTitle: 'Codex 导入', importAttachments: false } };
  view.state.rows.owner = [{ id: 'codex-import-abcdef1234', status: 'completed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify(data) + '\n' }; view.tick();
  assert.equal(view.heading.textContent, '预览完成，请确认导入');
  assert.equal(view.labelled('导入确认').hidden, false);
  assert.match(view.labelled('本次导入范围').textContent, /3 条会话/);
  assert.match(view.labelled('导入统计').textContent, /有正文 2/);
  assert.equal(view.calls.filter(c => c[0] === 'execute').length, 0);
  assert.equal(view.close.textContent, '暂不导入');
  view.close.dispatchEvent(new Event('click'));
  assert.equal(view.calls.filter(c => c[0] === 'execute').length, 0);
  view.result('owner', 'codex-import', { kind: 'success', text: previewReceipt });
  const button = view.labelled('确认导入');
  button.dispatchEvent(new Event('click')); button.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  const calls = view.calls.filter(c => c[0] === 'execute');
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'owner');
  assert.equal(calls[0][2], '/codex-import import-confirm {"token":"reviewed"}');
  assert.equal(view.labelled('导入确认').hidden, true);
});

test('cancelled and expired previews cannot import', t => {
  const view = mount(t);
  view.result('owner', 'codex-import', { kind: 'success', text: receipt.replace('导入任务', '预览任务') });
  view.state.rows.owner = [{ id: 'codex-import-abcdef1234', status: 'killed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify({ mode: 'preview', phase: 'cancelled', processed: 0 }) }; view.tick();
  assert.equal(view.labelled('导入确认').hidden, true);
  view.state.rows.owner[0].status = 'completed';
  view.state.observed['codex-import-abcdef1234'].text = JSON.stringify({ mode: 'preview', phase: 'completed', processed: 1,
    importProposal: { token: 'expired', expiresAt: Date.now() - 1 } }); view.tick();
  assert.equal(view.labelled('确认导入').disabled, true);
  view.labelled('确认导入').dispatchEvent(new Event('click'));
  assert.equal(view.calls.filter(c => c[0] === 'execute').length, 0);
});

test('preview shows reviewed original directory counts and explicit fallback before confirmation', t => {
  const view = mount(t);
  view.result('s', 'codex-import', { kind: 'success', text: receipt.replace('导入任务', '预览任务') });
  const destinationSummary = { mode: 'original', originalSessions: 8, originalProjects: 2, fallbackSessions: 2, fallbackPath: '/fallback' };
  view.state.rows.s = [{ id: 'codex-import-abcdef1234', status: 'completed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify({ mode: 'preview', phase: 'completed', total: 10, processed: 10,
    destinationSummary, importProposal: { token: 'reviewed', expiresAt: Date.now() + 10000, count: 10, groupByProject: true,
      sourceHome: '/source', destinationPath: '/fallback', destinationSummary, withBody: 10, metadataOnly: 0 } }) };
  view.tick();
  assert.match(view.labelled('导入统计').textContent, /原项目 8 条 \/ 2 个目录；回退 2 条/);
  assert.match(view.labelled('本次导入范围').textContent, /无有效原目录 2 条 → \/fallback/);
  assert.equal(view.calls.filter(c => c[0] === 'execute').length, 0);
});

test('import completion refreshes the native session list once without requiring a catalog click', async t => {
  let refreshes = 0;
  const view = mount(t, { sessions: { async refresh() { refreshes++; } } });
  view.result('s', 'codex-import', { kind: 'success', text: receipt });
  view.state.rows.s = [{ id: 'codex-import-abcdef1234', status: 'completed' }];
  view.state.observed['codex-import-abcdef1234'] = { text: JSON.stringify({ mode: 'import', phase: 'completed', processed: 1378, total: 1378 }) };
  view.tick(); view.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  view.result('s', 'codex-import', { kind: 'success', text: receipt });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshes, 1);
});
