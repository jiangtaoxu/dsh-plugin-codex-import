import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAttachmentDetails, attachmentSummaryText } from '../src/attachment-details.js';

const count = (unique, references = unique) => ({ unique, references });
const audit = { id: 'audit-one', complete: true, available: { images: count(2, 3), files: count(1) },
  missing: { images: count(3, 7), files: count(4, 9) },
  reasons: [{ code: 'missing', label: '原文件不存在', images: count(3, 7), files: count(4, 9) }] };
const row = { name: '<img src=x onerror=alert(1)>.png', type: 'image', status: 'missing', source: '/目录/缺失.png',
  reason: '原文件不存在', detail: '原文件已不存在', references: 7,
  conversations: [{ id: 'codex-original-id', title: '中文历史', project: '/原项目', references: 7, messages: ['message-key'] }] };

function mount(t, request) {
  const dom = new JSDOM('<body><button id="open">查看附件统计与明细</button></body>', { url: 'http://local/' });
  const original = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  globalThis.fetch = request;
  const button = dom.window.document.querySelector('#open'); const ui = createAttachmentDetails(button);
  t.after(() => { ui.dispose(); dom.window.close(); Object.assign(globalThis, original); });
  return { button, ui, dom, doc: dom.window.document,
    label: label => dom.window.document.querySelector(`[aria-label="${label}"]`) };
}
const response = (extra = {}) => new Response(JSON.stringify({ audit, total: 31, page: 1, pages: 2, rows: [row], ...extra }));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('attachment details open only on demand, show separate de-duplicated totals, reasons and exact sources safely', async t => {
  const urls = [];
  const view = mount(t, async url => { urls.push(new URL(url, 'http://local')); return response(); });
  assert.equal(view.button.hidden, true); view.ui.update(audit); assert.equal(urls.length, 0);
  view.button.click(); await tick();
  assert.equal(view.label('附件统计与明细').open, true);
  assert.match(view.label('附件分类统计').textContent, /3 \/ 7/);
  assert.match(view.label('按缺失原因统计').textContent, /原文件不存在/);
  assert.equal(urls[0].searchParams.get('status'), 'missing');
  assert.match(view.label('附件明细列表').textContent, /\/目录\/缺失.png/);
  assert.match(view.label('附件明细列表').textContent, /codex-original-id/);
  assert.equal(view.label('附件明细列表').querySelector('img'), null);
  const back = [...view.doc.querySelectorAll('button')].find(node => node.textContent === '返回预览');
  back.click(); assert.equal(view.label('附件统计与明细').open, false);
  assert.match(attachmentSummaryText(audit), /不可导入：图片 3 项 \/ 7 次引用，文件 4 项 \/ 9 次引用/);
});

test('attachment details filter, search all pages, navigate and recover from expired reports', async t => {
  const urls = [];
  const view = mount(t, async url => {
    const u = new URL(url, 'http://local'); urls.push(u);
    if (u.searchParams.get('q') === 'expired') return new Response(JSON.stringify({ error: '明细已失效' }), { status: 404 });
    return response({ page: Number(u.searchParams.get('page') || 1) });
  });
  view.ui.update(audit); view.button.click(); await tick();
  const next = [...view.doc.querySelectorAll('button')].find(node => node.textContent === '下一页');
  next.click(); await tick(); assert.equal(urls.at(-1).searchParams.get('page'), '2');
  const type = view.label('附件类型'); type.value = 'image'; type.dispatchEvent(new view.dom.window.Event('change')); await tick();
  assert.equal(urls.at(-1).searchParams.get('type'), 'image'); assert.equal(urls.at(-1).searchParams.get('page'), '1');
  const reason = view.label('附件缺失原因'); reason.value = 'missing'; reason.dispatchEvent(new view.dom.window.Event('change')); await tick();
  assert.equal(urls.at(-1).searchParams.get('reason'), 'missing');
  const search = view.label('搜索附件明细'); search.value = 'expired'; search.dispatchEvent(new view.dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.match(view.label('附件明细状态').textContent, /明细已失效/);
  assert.equal(view.label('附件明细列表').children.length, 0);
});

test('a newer report never displays delayed rows from an older request', async t => {
  let release;
  const view = mount(t, async () => new Promise(resolve => { release = resolve; }));
  view.ui.update(audit); view.button.click();
  view.ui.update({ ...audit, id: 'new-audit' });
  release(response()); await tick();
  assert.equal(view.label('附件明细列表').children.length, 0);
});
