import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import AttachmentStore from '@deepseek-ai/dsh-attachment-local';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream';
import { prepareAttachments, mentionedFiles } from '../src/media.js';
import { convertSnapshot } from '../src/convert.js';
import { importCodex } from '../src/importer.js';
import { inspectImportedFile } from '../src/cleanup.js';

function png() {
  const chunk = (type, value) => {
    const data = Buffer.concat([Buffer.from(type), value]); const size = Buffer.alloc(4); size.writeUInt32BE(value.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data)); return Buffer.concat([size, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255,0,255,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-media-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, '原项目'); const home = join(root, 'codex'); await mkdir(cwd); await mkdir(home);
  const image = join(cwd, '截图 中文.png'); const file = join(cwd, '文档 中文.txt');
  await writeFile(image, png()); await writeFile(file, '完整的文件原文\n');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(AttachmentStore, { dshHome: join(root, 'harness') });
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' });
  const services = { attachments: ctx.attachments, sessionPersistence: ctx.sessionPersistence, formatVersion: SESSION_FORMAT_VERSION };
  return { root, cwd, home, image, file, ctx, services };
}
function snapshot(f, blocks) {
  return { thread: { id: 'one', title: '带附件的对话', cwd: f.cwd }, createdAt: 1, mode: 'sqlite', turns: [],
    records: [{ key: 'q', time: 2, item: { type: 'userMessage', content: blocks } }], supplemental: [], fingerprint: 'a'.repeat(64) };
}
async function readStoredFile(store, ref) { const chunks = []; for await (const chunk of store.readFileStream(ref)) chunks.push(chunk); return Buffer.concat(chunks); }
async function populate(f) {
  const state = new DatabaseSync(join(f.home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at_ms INTEGER,archived INTEGER)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('one', '附件会话', f.cwd, 1, 0); state.close();
  const db = new DatabaseSync(join(f.home, 'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT)');
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('one', 'turn', 'q', 1, 2, JSON.stringify({ type: 'userMessage', content: [
    { type: 'text', text: '查看图片和文档' }, { type: 'localImage', path: f.image }, { type: 'file', path: f.file },
  ] })); db.close();
}

test('native images and files survive cold reopening and source removal, with raw records unchanged', async t => {
  const f = await fixture(t); const original = snapshot(f, [
    { type: 'text', text: '查看附件' }, { type: 'localImage', path: f.image }, { type: 'file', path: f.file },
  ]); const raw = structuredClone(original.records);
  const summary = await prepareAttachments(original, f.ctx.attachments, { dryRun: false });
  assert.deepEqual(summary, { images: 1, files: 1, missing: 0, found: 2, available: 2 });
  assert.deepEqual(original.records, raw);
  const converted = convertSnapshot('/source/.codex', original, SESSION_FORMAT_VERSION);
  const writer = await f.ctx.sessionPersistence.create(converted.header); await writer.append(converted.events); await writer.close();
  const reader = await f.ctx.sessionPersistence.open(converted.header.id, 'read'); const events = (await reader.read()).events; await reader.close();
  const blocks = events.find(event => event.type === 'user/message').data.content;
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'file']);
  assert.equal(await readFile(f.file, 'utf8'), '完整的文件原文\n');
  await rm(f.image); await rm(f.file); await f.ctx.fiber.dispose();
  const cold = new Context(); t.after(() => cold.fiber.dispose());
  await cold.plugin(AttachmentStore, { dshHome: join(f.root, 'harness') });
  await cold.plugin(Jsonl, { root: join(f.root, 'sessions'), compression: 'zstd' });
  const handle = await cold.sessionPersistence.open(converted.header.id, 'read'); await handle.read(); await handle.close();
  assert.deepEqual(Buffer.from((await cold.attachments.readImage(blocks[1].attachment)).data), png());
  assert.equal((await readStoredFile(cold.attachments, blocks[2].attachment)).toString(), '完整的文件原文\n');
  const location = await cold.sessionPersistence.stat(converted.header.id);
  assert.ok(await inspectImportedFile(location.location.path, converted.header.id));
});

test('inline images and uniquely matched rollout images recover missing temporary screenshots', async t => {
  const f = await fixture(t); const url = 'data:image/png;base64,' + png().toString('base64');
  const s = snapshot(f, [{ type: 'text', text: '同一个明确的问题' }, { type: 'localImage', path: join(f.cwd, '已过期.png') }]);
  s.supplemental = [{ item: { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '同一个明确的问题' }, { type: 'input_image', image_url: url },
  ] } } }];
  const summary = await prepareAttachments(s, f.ctx.attachments, { dryRun: false });
  assert.equal(summary.images, 1); assert.equal(summary.missing, 0); assert.equal(summary.found, 1);
  assert.equal(s.mediaMessages.get('q').content[1].type, 'image');
  const inline = snapshot(f, [{ type: 'image', url }]);
  await prepareAttachments(inline, f.ctx.attachments, { dryRun: false });
  assert.equal(inline.mediaMessages.get('q').content[0].attachment.attachmentId, s.mediaMessages.get('q').content[1].attachment.attachmentId);
});

test('ambiguous rollout prompts never borrow a different image', async t => {
  const f = await fixture(t); const s = snapshot(f, [{ type: 'text', text: '重复问题' }, { type: 'localImage', path: join(f.cwd, '不存在.png') }]);
  s.supplemental = ['AAAA', 'BBBB'].map(value => ({ item: { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '重复问题' }, { type: 'input_image', image_url: 'data:image/png;base64,' + value },
  ] } } }));
  const summary = await prepareAttachments(s, f.ctx.attachments, { dryRun: false });
  assert.equal(summary.missing, 1); assert.match(s.mediaMessages.get('q').content[1].text, /原文件已不存在/);
});

test('preview inspects availability without creating any Harness attachment objects', async t => {
  const f = await fixture(t); const s = snapshot(f, [{ type: 'localImage', path: f.image }, { type: 'file', path: f.file }]);
  const before = s.fingerprint; const summary = await prepareAttachments(s, undefined, { dryRun: true });
  assert.equal(summary.available, 2); assert.equal(s.fingerprint, before); assert.equal(s.mediaMessages, undefined);
  await assert.rejects(access(join(f.root, 'harness', 'attachments')));
});

test('explicit file wrappers are copied once and ordinary project paths are not imported', async t => {
  const f = await fixture(t);
  const value = `# Files mentioned by the user:\n\n## 截图: ${f.image}\nImage attachment: true\n## 文档: ${f.file}\n\n## My request:\n查看 ${f.cwd}/代码.dart`;
  assert.equal(mentionedFiles(value).length, 2); assert.deepEqual(mentionedFiles('代码位置 /project/code.dart'), []);
  const s = snapshot(f, [{ type: 'text', text: value }, { type: 'localImage', path: f.image }]);
  const summary = await prepareAttachments(s, f.ctx.attachments, { dryRun: false });
  assert.equal(summary.found, 2); assert.equal(summary.images, 1); assert.equal(summary.files, 1);
  assert.equal(s.mediaMessages.get('q').content.filter(block => block.type === 'image').length, 1);
});

test('missing, invalid, oversized and remote attachments become readable placeholders without fetching', async t => {
  const f = await fixture(t); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('must never fetch remote images'); }; t.after(() => { globalThis.fetch = original; });
  const s = snapshot(f, [{ type: 'image', url: 'https://example.invalid/image.png' }, { type: 'image', url: 'data:image/png;base64,@@@@' }, { type: 'file', path: f.file }]);
  const summary = await prepareAttachments(s, f.ctx.attachments, { dryRun: false, maxAttachmentBytes: 1 });
  assert.equal(summary.missing, 3); assert.equal(calls, 0);
  assert.ok(s.mediaMessages.get('q').content.every(block => block.type === 'text' && block.text.includes('附件未导入')));
});

test('assistant image streams and generated download cards preserve valid native session structure', async t => {
  const f = await fixture(t); const s = snapshot(f, [{ type: 'text', text: '生成附件' }]);
  s.records.push({ key: 'view', time: 3, item: { type: 'imageView', path: f.image } },
    { key: 'reply', time: 4, item: { type: 'agentMessage', text: `文档：[查看文件](<${f.file}>)` } });
  await prepareAttachments(s, f.ctx.attachments, { dryRun: false });
  const converted = convertSnapshot('/source/.codex', s, SESSION_FORMAT_VERSION);
  const writer = await f.ctx.sessionPersistence.create(converted.header); await writer.append(converted.events); await writer.close();
  const reader = await f.ctx.sessionPersistence.open(converted.header.id, 'read'); const events = (await reader.read()).events; await reader.close();
  const image = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'image'));
  assert.ok(expandAssistantStream(image.data.stream).some(entry => entry.chunk?.type === 'block-end' && entry.chunk.block.type === 'image'));
  const files = events.find(event => event.type === 'codex-import/files'); assert.equal(files.data.files[0].attachment.name, '文档 中文.txt');
  assert.equal((await readFile(files.data.files[0].hostPath)).toString(), '完整的文件原文\n');
});

test('attachment upgrades are repeatable independent snapshots and preserve old Harness continuations', async t => {
  const f = await fixture(t); await populate(f);
  const first = await importCodex(f.services, { codexHome: f.home, groupByProject: true, syncExisting: false, dryRun: false, importAttachments: false }); assert.deepEqual(first.failed, []);
  const old = (await f.ctx.sessionPersistence.list())[0]; const writer = await f.ctx.sessionPersistence.open(old.header.id, 'write'); const events = (await writer.read()).events;
  await writer.append([{ seq: events.length, time: 9, type: 'test/continued', ignorable: true, data: { text: '保持原有续聊' } }]); await writer.close();
  const original = await readFile(old.location.path); const sourceBytes = await readFile(join(f.home, 'thread_history_1.sqlite'));
  const options = { codexHome: f.home, groupByProject: true, syncExisting: false, dryRun: false };
  const result = await importCodex(f.services, options); assert.deepEqual(result.failed, []); assert.equal(result.imported, 1); assert.equal(result.attachmentImages, 1); assert.equal(result.attachmentFiles, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
  const again = await importCodex(f.services, options); assert.equal(again.skipped, 1); assert.equal(again.imported, 0);
  assert.deepEqual(await readFile(old.location.path), original); assert.deepEqual(await readFile(join(f.home, 'thread_history_1.sqlite')), sourceBytes);
});

test('default incremental sync upgrades attachments in place, skips repeats, and retains old bytes if source files disappear', async t => {
  const f = await fixture(t); await populate(f);
  const options = { codexHome: f.home, dryRun: false };
  assert.equal((await importCodex(f.services, { ...options, importAttachments: false })).imported, 1);
  const old = (await f.ctx.sessionPersistence.list())[0]; const prefix = await readFile(old.location.path);
  const upgraded = await importCodex(f.services, options); assert.deepEqual(upgraded.failed, []); assert.equal(upgraded.updated, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
  assert.deepEqual((await readFile(old.location.path)).subarray(0, prefix.length), prefix);
  assert.equal((await importCodex(f.services, options)).skipped, 1);
  const reader = await f.ctx.sessionPersistence.open(old.header.id, 'read'); const events = (await reader.read()).events; await reader.close();
  const ref = events.findLast(e => e.type === 'user/message').data.content.find(block => block.type === 'image').attachment;
  await rm(f.image); await rm(f.file);
  const missing = await importCodex(f.services, options); assert.deepEqual(missing.failed, []); assert.equal(missing.updated, 1);
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(ref)).data), png());
  assert.equal((await importCodex(f.services, options)).skipped, 1);
  assert.equal((await inspectImportedFile(old.location.path, old.header.id)).continued, false);
});

test('cancellation before preparation writes no native objects', async t => {
  const f = await fixture(t); const s = snapshot(f, [{ type: 'localImage', path: f.image }]);
  const control = new AbortController(); control.abort();
  await assert.rejects(prepareAttachments(s, f.ctx.attachments, { dryRun: false }, control.signal));
  await assert.rejects(access(join(f.root, 'harness', 'attachments')));
});

test('captured rollout bytes take precedence over a local image modified after the conversation', async t => {
  const f = await fixture(t); await writeFile(f.image, '文件已经被其他内容覆盖');
  const s = snapshot(f, [{ type: 'text', text: '历史时刻的问题' }, { type: 'localImage', path: f.image }]);
  s.supplemental = [{ item: { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '历史时刻的问题' }, { type: 'input_image', image_url: 'data:image/png;base64,' + png().toString('base64') },
  ] } } }];
  const summary = await prepareAttachments(s, f.ctx.attachments, { dryRun: false }); assert.equal(summary.images, 1); assert.equal(summary.missing, 0);
  const ref = s.mediaMessages.get('q').content[1].attachment;
  assert.equal(ref.name, '截图 中文.png'); assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(ref)).data), png());
});

test('generated image wrapper triples match exact original paths without relaxing user text matching', async t => {
  const f = await fixture(t); const missing = join(f.cwd, '过期截图.png');
  const make = path => {
    const s = snapshot(f, [{ type: 'text', text: '原始问题' }, { type: 'localImage', path: missing }]);
    s.supplemental = [{ item: { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '原始问题' }, { type: 'input_text', text: `<image name=[Image #1] path="${path}">` },
      { type: 'input_image', image_url: 'data:image/png;base64,' + png().toString('base64') }, { type: 'input_text', text: '</image>' },
    ] } } }]; return s;
  };
  const exact = make(missing); const good = await prepareAttachments(exact, f.ctx.attachments, { dryRun: false }); assert.equal(good.images, 1); assert.equal(good.missing, 0);
  const wrong = make(join(f.cwd, '其他截图.png')); const refused = await prepareAttachments(wrong, f.ctx.attachments, { dryRun: false }); assert.equal(refused.images, 0); assert.equal(refused.missing, 1);
});

test('attachment audit normalizes source identities, separates images/files and classifies failures without changing history', async t => {
  const { AttachmentAudit } = await import('../src/attachment-audit.js');
  const { pathToFileURL } = await import('node:url');
  const f = await fixture(t); const audit = new AttachmentAudit();
  const missing = join(f.cwd, '缺失.png');
  const s = snapshot(f, [{ type: 'localImage', path: missing }, { type: 'localImage', path: './缺失.png' },
    { type: 'image', url: pathToFileURL(missing).href }, { type: 'file', path: join(f.cwd, '缺失.pdf') },
    { type: 'image', url: 'https://example.invalid/image.png' }, { type: 'localImage', path: f.image },
    { type: 'file', path: '' }, { type: 'file', path: f.cwd }]);
  const original = structuredClone(s.records);
  await prepareAttachments(s, undefined, { dryRun: true }, undefined, undefined, (entry, thread, key) => audit.add(entry, thread, key));
  assert.deepEqual(s.records, original); assert.equal(s.mediaMessages, undefined);
  const stats = audit.snapshot();
  assert.deepEqual(stats.missing.images, { unique: 2, references: 4 });
  assert.equal(stats.missing.files.unique, 3); assert.equal(stats.available.images.unique, 1);
  assert.equal(stats.reasons.find(r => r.code === 'missing').images.unique, 1);
  assert.equal(stats.reasons.find(r => r.code === 'remote').images.unique, 1);
  assert.equal(stats.reasons.find(r => r.code === 'path').files.unique, 2);
  const details = audit.query().rows;
  assert.equal(details.find(row => row.source === missing).references, 3);
  const errors = [Object.assign(new Error('permission'), { code: 'EACCES' }),
    Object.assign(new Error('pixel limit'), { code: 'IMAGE_TOO_MANY_PIXELS' }),
    Object.assign(new Error('malformed'), { code: 'INVALID_IMAGE' })];
  for (const error of errors) {
    await prepareAttachments(snapshot(f, [{ type: 'localImage', path: f.image }]), { async validateImage() { throw error; } },
      { dryRun: true }, undefined, undefined, (entry, thread, key) => audit.add(entry, thread, key));
  }
  assert.ok(['permission', 'too-large', 'format'].every(code => audit.snapshot().reasons.some(row => row.code === code)));
});

test('inline image dedup uses bytes and global reports retain missing detail sources after preview', async t => {
  const { AttachmentAudit, AttachmentAudits } = await import('../src/attachment-audit.js');
  const f = await fixture(t); const audit = new AttachmentAudit(); const encoded = png().toString('base64');
  for (const url of ['data:image/png;base64,' + encoded, 'data:image/png;base64,' + encoded.replace(/(.{12})/g, '$1\n')]) {
    await prepareAttachments(snapshot(f, [{ type: 'image', url }]), undefined, { dryRun: true }, undefined, undefined,
      (entry, thread, key) => audit.add(entry, thread, key));
  }
  assert.deepEqual(audit.snapshot().available.images, { unique: 1, references: 2 });
  assert.doesNotMatch(JSON.stringify(audit.query(new URLSearchParams({ status: 'available' }))), /data:image/);
  await populate(f); await rm(f.image);
  const audits = new AttachmentAudits(); const progress = [];
  const report = await importCodex({ createAttachmentAudit: () => audits.create() }, { codexHome: f.home, dryRun: true }, undefined, data => progress.push(data));
  assert.equal(report.attachmentAudit.complete, true); assert.equal(report.attachmentAudit.missing.images.unique, 1);
  assert.equal(report.attachmentAudit.available.files.unique, 1);
  assert.equal(audits.reports.get(report.attachmentAudit.id).query().rows[0].conversations[0].id, 'one');
  assert.ok(progress.some(data => data.attachmentAudit?.missing.images.references === 1));
  assert.equal((await f.ctx.sessionPersistence.list()).length, 0);
});

test('code location links are separate references, deduplicate by actual file and never inflate missing attachments', async t => {
  const { AttachmentAudit } = await import('../src/attachment-audit.js');
  const f = await fixture(t); const audit = new AttachmentAudit();
  const s = snapshot(f, []);
  s.records = [{ key: 'a', item: { type: 'agentMessage', text: `[代码](${f.cwd}/不存在.dart#L123)\n[其他行](${f.cwd}/不存在.dart#L234-L240)\n[冒号行](${f.cwd}/不存在.dart:200:3)\n[下载](${f.file})\n\`\`\`\n[示例](${f.cwd}/fake.dart#L10)\n\`\`\`` } }];
  const raw = structuredClone(s.records);
  const counts = await prepareAttachments(s, undefined, { dryRun: true }, undefined, undefined,
    (entry, thread, key) => audit.add(entry, thread, key));
  assert.equal(counts.missing, 0); assert.equal(counts.found, 1); assert.equal(counts.files, 1);
  assert.deepEqual(audit.snapshot().reference.files, { unique: 1, references: 3 });
  assert.equal(audit.query(new URLSearchParams({ status: 'reference' })).rows[0].locations.length, 3);
  assert.equal(audit.query().total, 0); assert.deepEqual(s.records, raw);
});

test('unknown attachment locations are not falsely deduplicated as one file', async t => {
  const { AttachmentAudit } = await import('../src/attachment-audit.js');
  const f = await fixture(t); const audit = new AttachmentAudit();
  const s = snapshot(f, [{ type: 'file' }, { type: 'file' }]);
  await prepareAttachments(s, undefined, { dryRun: true }, undefined, undefined, (entry, thread, key) => audit.add(entry, thread, key));
  assert.deepEqual(audit.snapshot().missing.files, { unique: 2, references: 2 });
});
