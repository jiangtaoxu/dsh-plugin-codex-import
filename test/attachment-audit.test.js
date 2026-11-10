import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentAudit, AttachmentAudits, installAttachmentAuditRoute } from '../src/attachment-audit.js';

const thread = { id: 'one', title: '中文会话', cwd: '/项目' };
const entry = (identity, extra = {}) => ({ identity, source: '/图片/' + identity, name: '截图.png', type: 'image', reasonCode: 'missing', detail: '原文件已不存在', ...extra });

test('attachment counts deduplicate across messages and conversations while keeping all references and causes', () => {
  const audit = new AttachmentAudit();
  audit.add(entry('a'), thread, 'message1'); audit.add(entry('a'), thread, 'message2');
  audit.add(entry('a'), { ...thread, id: 'two', title: '另一个项目' }, 'message3');
  audit.add(entry('b', { type: 'file', name: '报告.docx', reasonCode: 'permission' }), thread, 'message4');
  audit.add(entry('a', { reasonCode: 'permission' }), thread, 'message5');
  audit.add(entry('a', { reasonCode: undefined }), thread, 'message6');
  const summary = audit.snapshot();
  assert.deepEqual(summary.missing.images, { unique: 1, references: 4 });
  assert.deepEqual(summary.missing.files, { unique: 1, references: 1 });
  assert.equal(summary.available.images.unique, 1);
  assert.equal(summary.reasons.find(r => r.code === 'missing').images.references, 3);
  assert.equal(summary.reasons.find(r => r.code === 'permission').images.unique, 1);
  const detail = audit.query(new URLSearchParams({ q: '另一个项目' }));
  assert.equal(detail.total, 1); assert.equal(detail.rows[0].references, 3);
  assert.equal(detail.rows[0].conversations.length, 2);
  assert.deepEqual(detail.rows[0].conversations[0].messages, ['message1', 'message2']);
  assert.equal(audit.query(new URLSearchParams({ type: 'file', reason: 'permission' })).total, 1);
  summary.missing.images.unique = 999; assert.equal(audit.snapshot().missing.images.unique, 1);
});

test('detail queries search the whole report before paging and never silently truncate rows', () => {
  const audit = new AttachmentAudit();
  for (let i = 0; i < 83; i++) audit.add(entry('file-' + i, { name: i === 82 ? '最后一项.png' : '截图.png' }), thread, 'm');
  const first = audit.query(); assert.equal(first.rows.length, 30); assert.equal(first.total, 83); assert.equal(first.pages, 3);
  assert.equal(audit.query(new URLSearchParams({ page: '3' })).rows.length, 23);
  assert.equal(audit.query(new URLSearchParams({ q: '最后一项' })).total, 1);
  assert.equal(audit.query(new URLSearchParams({ page: '-9' })).page, 1);
  assert.equal(audit.query(new URLSearchParams({ page: 'NaN' })).page, 1);
  assert.equal(audit.query(new URLSearchParams({ status: 'available' })).total, 0);
});

test('native authenticated GET route provides paginated audits without exposing arbitrary paths', async () => {
  const store = new AttachmentAudits(); const a = store.create(); a.add(entry('one'), thread, 'm');
  let route;
  installAttachmentAuditRoute({ connection: { fetch: { register(value) { route = value; } } } }, store);
  assert.deepEqual(route.methods, ['GET']);
  const response = await route.fetch(new Request(`http://local/api/codex-import/attachments?id=${a.id}`));
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).total, 1);
  for (let i = 0; i < 3; i++) store.create();
  assert.equal((await route.fetch(new Request(`http://local/api/codex-import/attachments?id=${a.id}`))).status, 404);
  assert.equal((await route.fetch(new Request('http://local/api/codex-import/attachments?id=/etc/passwd'))).status, 404);
});
