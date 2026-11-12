import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImportWizard } from '../src/import-wizard.js';

const setup = { source: 'codex', codexHome: '/configured/codex', codexSources: [{ path: '/configured/codex', label: '当前配置的 Codex' }, { path: '/other/codex', label: '默认 Codex' }],
  maxArchiveBytes: 1024 ** 3, defaults: { importAttachments: true, includeArchived: true, checkOverlap: true, importWorkspacePath: '' } };
async function mount(t, requestOverride, previewOverride) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://dsh' }), oldStorage = globalThis.localStorage;
  globalThis.localStorage = dom.window.localStorage;
  const calls = [], previews = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.endsWith('/setup')) return Response.json(setup);
    if (requestOverride) return requestOverride(url, options);
    return Response.json(options.method === 'POST' ? { id: 'upload-one', expiresAt: Date.now() + 60000 } : { ok: true });
  };
  const wizard = createImportWizard({ element(tag, label) { const n = dom.window.document.createElement(tag); if (label) n.setAttribute('aria-label', label); return n; },
    getSession: async owner => owner || 'control-session', request, onPreview: async (...args) => { previews.push(args); if (previewOverride) await previewOverride(...args); } });
  dom.window.document.body.append(wizard.node);
  t.after(() => { wizard.dispose(); dom.window.close(); globalThis.localStorage = oldStorage; });
  await wizard.open('owner');
  const labelled = label => dom.window.document.querySelector(`[aria-label="${label}"]`);
  const drop = files => { const event = new dom.window.Event('drop', { cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { files } }); labelled('拖放 ChatGPT ZIP').dispatchEvent(event); };
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { wizard, dom, labelled, calls, previews, drop, flush };
}

test('source chooser discovers Codex directories and only starts preview on explicit click', async t => {
  const view = await mount(t);
  assert.equal(view.previews.length, 0); assert.equal(view.calls.length, 1);
  assert.equal(view.labelled('选择 Codex 数据目录').options.length, 2);
  view.labelled('选择 Codex 数据目录').value = '/other/codex';
  view.labelled('开始预览').click(); view.labelled('开始预览').click(); await view.flush();
  assert.equal(view.previews.length, 1); assert.deepEqual(view.previews[0], ['owner', { source: 'codex', codexHome: '/other/codex', importAttachments: true, includeArchived: true }]);
  assert.equal(view.calls.filter(c => c.method === 'POST').length, 0);
});

test('dropping or picking a ZIP uses the file body and a token instead of a filesystem path', async t => {
  const view = await mount(t); view.labelled('导入 ChatGPT 导出包').click();
  assert.equal(view.labelled('开始预览').disabled, true);
  const file = new File(['synthetic zip bytes'], '中文 export.zip', { type: 'application/zip' });
  view.drop([file]); assert.match(view.labelled('已选择的 ZIP').textContent, /中文 export.zip/);
  assert.equal(view.calls.length, 1);
  view.labelled('开始预览').click(); await view.flush();
  const upload = view.calls.find(c => c.method === 'POST'); assert.equal(upload.body, file);
  assert.ok(upload.url.includes('sessionId=owner'));
  assert.deepEqual(view.previews[0], ['owner', { source: 'chatgpt', uploadToken: 'upload-one', importAttachments: true, includeArchived: true, checkOverlap: true }]);
  assert.equal(Object.hasOwn(view.previews[0][1], 'archivePath'), false);
  const picker = view.labelled('ChatGPT ZIP 文件选择器');
  Object.defineProperty(picker, 'files', { value: [new File(['another'], 'next.zip')], configurable: true });
  picker.dispatchEvent(new view.dom.window.Event('change')); await view.flush();
  assert.ok(view.calls.some(c => c.method === 'DELETE'));
  assert.match(view.labelled('已选择的 ZIP').textContent, /next.zip/);
});

test('invalid selections and upload errors stay in the chooser and allow retry', async t => {
  let fail = true;
  const view = await mount(t, async (_url, options) => options.method !== 'POST' ? Response.json({ ok: true })
    : fail ? Response.json({ error: '这个 ZIP 中没有 ChatGPT 对话' }, { status: 400 }) : Response.json({ id: 'retry-token', expiresAt: Date.now() + 60000 }));
  view.labelled('导入 ChatGPT 导出包').click(); view.drop([new File(['wrong'], 'data.txt')]);
  assert.match(view.labelled('导入来源错误').textContent, /ZIP/); assert.equal(view.labelled('开始预览').disabled, true);
  view.drop([new File(['data'], 'export.zip')]); view.labelled('开始预览').click(); await view.flush();
  assert.match(view.labelled('导入来源错误').textContent, /没有 ChatGPT/); assert.equal(view.previews.length, 0);
  fail = false; view.labelled('开始预览').click(); await view.flush(); assert.equal(view.previews.length, 1);
});

test('cancelling file preparation aborts transfer and never launches preview', async t => {
  let uploadSignal;
  const view = await mount(t, async (_url, options) => new Promise((_resolve, reject) => {
    uploadSignal = options.signal; options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  view.labelled('导入 ChatGPT 导出包').click(); view.drop([new File(['data'], 'export.zip')]); view.labelled('开始预览').click(); await view.flush();
  assert.equal(view.labelled('文件准备进度').hidden, false);
  view.wizard.cancel(); await view.flush(); assert.equal(uploadSignal.aborted, true); assert.equal(view.previews.length, 0);
});

test('switching source releases its staged file and remembers the source preference', async t => {
  const view = await mount(t, undefined, async () => { throw new Error('preview unavailable'); });
  view.labelled('导入 ChatGPT 导出包').click(); view.drop([new File(['data'], 'export.zip')]); view.labelled('开始预览').click(); await view.flush();
  view.labelled('导入本地 Codex').click(); await view.flush();
  assert.ok(view.calls.some(c => c.method === 'DELETE')); assert.equal(globalThis.localStorage.getItem('codex-import.source'), 'codex');
  assert.equal(view.labelled('导入高级选项').open, false);
});
