import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import AttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { Session, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { ExportArchive } from '../src/archive.js';
import { ChatGPTSource, conversationPath } from '../src/chatgpt-source.js';
import { projectedRecords, convertSnapshot } from '../src/convert.js';
import { prepareAttachments } from '../src/media.js';
import { importCodex } from '../src/importer.js';
import { ImportPlans } from '../src/import-plans.js';
import { importedState, buildSyncTransaction } from '../src/sync.js';
import { inspectImportedFile } from '../src/cleanup.js';
import { readImportedCatalog } from '../src/catalog.js';
import { OverlapIndex, snapshotMessages, eventMessages } from '../src/overlap.js';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import { apply } from '../src/index.js';
import { latestProgress } from '../src/client.js';

function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.isBuffer(data) ? data : Buffer.from(data), packed = deflateRawSync(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10); record.writeUInt32LE(crc32(bytes), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, filename, packed); central.push(record, filename); offset += local.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function png() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), n = Buffer.alloc(4), crc = Buffer.alloc(4);
    n.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([n, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}
function node(id, parent, role, body, metadata) {
  return { id, parent, message: role ? { id: 'message-' + id, author: { role }, create_time: 10, content: body, ...(metadata ? { metadata } : {}) } : null };
}
function conversation(id = 'one') {
  return { id, conversation_id: id, title: '测试导出', create_time: 1, update_time: 12, current_node: 'a', default_model_slug: 'gpt-test', is_archived: true,
    mapping: {
      root: node('root', null),
      old: node('old', 'q', 'assistant', { content_type: 'text', parts: ['非当前分支的回答'] }),
      a: node('a', 'r', 'assistant', { content_type: 'text', parts: ['当前回答：' + '详细的说明。'.repeat(20)] }),
      q: node('q', 'root', 'user', { content_type: 'text', parts: ['用户问题：' + '需要完整处理。'.repeat(20)] }),
      r: node('r', 'q', 'assistant', { content_type: 'thoughts', thoughts: [{ summary: '思考摘要', content: '已导出的思考' }] }),
    } };
}
async function fixture(t, modify = c => c) {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-import-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'export'); await mkdir(directory);
  const c = modify(conversation());
  const entries = [ ['user.json', JSON.stringify({ id: 'test-account', email: 'never-persist@example.invalid' })],
    ['export_manifest.json', JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['conversations-000.json', 'conversations-001.json'], sharded: true } } })],
    ['conversations-000.json', JSON.stringify([c])], ['conversations-001.json', '[]'],
    ['conversation_asset_file_names.json', JSON.stringify({ 'file-image.dat': '图片.png', 'file-pdf.dat': '报告.pdf' })],
    ['file-image.dat', png()], ['file-pdf.dat', '%PDF-1.3\ntest'], ['file-audio.dat', Buffer.from('RIFFxxxxWAVEtest')],
    ['pages/page-test/metadata.json', '{}'], ['sites/export_manifest.json', '{}'], ['group_chats.json', '{"chats":[{}]}'] ];
  for (const [name, data] of entries) { const path = join(directory, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data); }
  const path = join(root, 'export.zip'); await writeFile(path, zip(entries));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' });
  await ctx.plugin(AttachmentStore, { dshHome: join(root, 'harness') });
  const services = { sessionPersistence: ctx.sessionPersistence, attachments: ctx.attachments, formatVersion: SESSION_FORMAT_VERSION };
  const options = { source: 'chatgpt', archivePath: path, importWorkspacePath: join(root, 'target'), dryRun: false };
  const edit = async () => writeFile(join(directory, 'conversations-000.json'), JSON.stringify([c]));
  return { root, directory, path, ctx, services, options, c, edit };
}
async function readSession(f) {
  const stored = (await f.ctx.sessionPersistence.list())[0], reader = await f.ctx.sessionPersistence.open(stored.header.id, 'read');
  try { return { stored, events: (await reader.read()).events }; } finally { await reader.close(); }
}
function validate(header, events) {
  assert.ok(new Session(header.id, events, header).deriveMessages().length);
  assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
}

test('ZIP and extracted exports reconstruct parent-only paths, preserve branches, metadata and native reasoning', async t => {
  const f = await fixture(t);
  const source = await new ChatGPTSource(f.path).open(); t.after(() => source.close());
  const directory = await new ChatGPTSource(f.directory).open(); t.after(() => directory.close());
  assert.equal(source.home, directory.home); assert.equal(source.list({ includeArchived: false }).length, 0);
  assert.deepEqual(conversationPath(f.c), ['root', 'q', 'r', 'a']);
  const snapshot = await source.read(source.list()[0]), other = await directory.read(directory.list()[0]);
  assert.equal(snapshot.fingerprint, other.fingerprint);
  assert.equal(source.summary.offPathMessages, 1); assert.equal(source.summary.branchedConversations, 1); assert.equal(source.summary.unsupported.length, 3);
  const projected = projectedRecords(snapshot).filter(p => p.projected);
  assert.deepEqual(projected.map(p => p.record.key), ['q', 'r', 'a']);
  assert.equal(projected[1].projected.content[0].type, 'reasoning');
  const converted = convertSnapshot(source.home, snapshot, SESSION_FORMAT_VERSION); validate(converted.header, converted.events);
  assert.ok(converted.header.id.startsWith('chatgpt-'));
  assert.equal(converted.events.filter(e => e.type === 'codex-import/raw').length, 5);
  assert.ok(!JSON.stringify(converted.events).includes('never-persist@example.invalid'));
  assert.ok(!JSON.stringify(eventMessages(converted.events)).includes('非当前分支'));
});

test('classic conversations.json, stable manual source IDs and malformed branch diagnostics', async t => {
  const f = await fixture(t); await rm(join(f.directory, 'export_manifest.json')); await rm(join(f.directory, 'user.json'));
  await writeFile(join(f.directory, 'conversations.json'), JSON.stringify([f.c]));
  await assert.rejects(new ChatGPTSource(f.directory).open(), /sourceId/);
  const source = await new ChatGPTSource(f.directory, 'my-account').open(); t.after(() => source.close());
  assert.equal(source.list().length, 1);
  f.c.mapping.q.parent = 'a'; assert.throws(() => conversationPath(f.c), /循环/);
  f.c.current_node = 'missing'; assert.throws(() => conversationPath(f.c), /current_node/);
});

test('archive rejects traversal, duplicate members, symlinks, corruption, size excess and cancellation', async t => {
  const f = await fixture(t);
  for (const entries of [[['../escape.json', '{}']], [['same.json', '{}'], ['same.json', '[]']]]) {
    await writeFile(f.path, zip(entries)); await assert.rejects(new ExportArchive(f.path).open(), /路径|invalid relative path/);
  }
  await symlink(join(f.directory, 'user.json'), join(f.directory, 'link.json'));
  await assert.rejects(new ExportArchive(f.directory).open(), /符号链接/);
  await rm(join(f.directory, 'link.json'));
  const archive = await new ExportArchive(f.directory).open(); t.after(() => archive.close());
  await assert.rejects(archive.bytes('file-image.dat', undefined, 1), /大小限制/);
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(new ExportArchive(f.directory).open(abort.signal), /cancelled/);
  const corrupted = zip([['bad.json', '{}']]);
  const central = corrupted.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); corrupted.writeUInt32LE(0, central + 16);
  await writeFile(f.path, corrupted);
  const damaged = await new ExportArchive(f.path).open(); t.after(() => damaged.close());
  await assert.rejects(damaged.json('bad.json'), /CRC/);
});

test('preview is read-only; native attachments, renamed ZIP deduplication, catalog and cleanup identity work', async t => {
  const f = await fixture(t, c => {
    c.mapping.q.message.content = { content_type: 'multimodal_text', parts: ['查看附件',
      { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-image' },
      { content_type: 'audio_transcription', text: '音频转写内容' },
      { content_type: 'audio_asset_pointer', asset_pointer: 'file-service://file-audio', format: 'wav' },
      { content_type: 'real_time_user_audio_video_asset_pointer', audio_asset_pointer: 'file-service://file-audio', frames_asset_pointers: [] }] };
    c.mapping.q.message.metadata = { attachments: [{ id: 'file-image', name: '重复图片.png', mime_type: 'image/png' }, { id: 'file-pdf', name: '报告.pdf', mime_type: 'application/pdf' }, { id: 'file-missing', name: '缺失.pdf' }] };
    return c;
  });
  const preview = await importCodex(f.services, { ...f.options, dryRun: true });
  assert.deepEqual(preview.failed, []); assert.equal(preview.attachmentImages, 1); assert.equal(preview.attachmentFiles, 2); assert.equal(preview.attachmentMissing, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 0);
  await assert.rejects(readFile(join(f.options.importWorkspacePath, 'anything')), /ENOENT/);
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []); assert.equal(result.imported, 1);
  const { stored, events } = await readSession(f); validate(stored.header, events);
  const blocks = events.find(e => e.type === 'user/message').data.content;
  assert.deepEqual(blocks.filter(b => ['image', 'file'].includes(b.type)).map(b => b.type), ['image', 'file', 'file']);
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(blocks.find(b => b.type === 'image').attachment)).data), png());
  assert.ok(blocks.some(b => b.text === '音频转写内容'));
  assert.ok(await inspectImportedFile(stored.location.path, stored.header.id));
  const catalog = await readImportedCatalog(stored); assert.equal(catalog.sourceKind, 'chatgpt'); assert.equal(catalog.projectTitle, 'ChatGPT 导入');
  const renamed = join(f.root, 'renamed.zip'); await copyFile(f.path, renamed);
  assert.equal((await importCodex(f.services, { ...f.options, archivePath: renamed })).skipped, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
  await rm(f.path); await rm(f.directory, { recursive: true });
  assert.deepEqual(Buffer.from((await f.ctx.attachments.readImage(blocks.find(b => b.type === 'image').attachment)).data), png());
});

test('confirmation binds export bytes and rejects changed ZIP or directory before writes', async t => {
  for (const directory of [false, true]) {
    const f = await fixture(t), options = { ...f.options, archivePath: directory ? f.directory : f.path };
    const report = await importCodex(f.services, { ...options, dryRun: true }), plans = new ImportPlans();
    const proposal = plans.create('owner', options, report), frozen = plans.confirm(proposal.token, 'owner');
    if (directory) { f.c.title = 'changed'; await f.edit(); } else await writeFile(f.path, zip([['user.json', '{"id":"test-account"}'], ['conversations.json', JSON.stringify([conversation('other')])]]));
    await assert.rejects(importCodex(f.services, { ...frozen, dryRun: false }), /发生变化/);
    assert.equal((await f.ctx.sessionPersistence.list()).length, 0);
  }
});

test('later exports append new messages and branch revisions without overwriting dsh continuation; interrupted sync resumes', async t => {
  const f = await fixture(t), options = { ...f.options, archivePath: f.directory, importAttachments: false };
  assert.equal((await importCodex(f.services, options)).imported, 1);
  let { stored, events } = await readSession(f);
  const continuation = convertSnapshot('/test', { thread: { id: 'native' }, createdAt: 1000, fingerprint: 'a'.repeat(64), mode: 'sqlite',
    records: [{ key: 'native', time: 1000, item: { type: 'userMessage', content: [{ type: 'text', text: 'dsh 续聊消息' }] } }], supplemental: [], turns: [],
    targetSessionId: stored.header.id, suppressHead: true, skipLocationNotice: true }, SESSION_FORMAT_VERSION).events.filter(e => !e.type.startsWith('codex-import/') && e.type !== 'session/title');
  const turnOffset = Math.max(...events.map(e => e.data.turn || 0));
  for (const [i, e] of continuation.entries()) { e.seq = events.length + i; if (e.data.turn) e.data.turn += turnOffset; }
  const writer = await f.ctx.sessionPersistence.open(stored.header.id, 'write'); await writer.append(continuation); await writer.close();
  const before = (await readSession(f)).events;
  f.c.mapping.next = node('next', 'a', 'user', { content_type: 'text', parts: ['导出后新增问题'] }); f.c.current_node = 'next'; await f.edit();
  assert.equal((await importCodex(f.services, options)).updated, 1);
  events = (await readSession(f)).events; assert.deepEqual(events.slice(0, before.length), before);
  assert.equal(eventMessages(events).filter(m => m.text === 'dsh 续聊消息').length, 1);
  f.c.current_node = 'old'; await f.edit();
  const source = await new ChatGPTSource(f.directory).open();
  const snapshot = await source.read(source.list()[0]); snapshot.destinationCwd = options.importWorkspacePath; source.close();
  const tx = buildSyncTransaction(stored.header, events, snapshot, SESSION_FORMAT_VERSION);
  const interrupted = await f.ctx.sessionPersistence.open(stored.header.id, 'write'); await interrupted.append([tx.begin, ...tx.body.slice(0, 3)]); await interrupted.close();
  assert.equal((await importCodex(f.services, options)).updated, 1);
  events = (await readSession(f)).events; validate(stored.header, events);
  assert.ok(eventMessages(events).some(m => m.text === '非当前分支的回答'));
  assert.equal(importedState(stored.header, events).pending, undefined);
  assert.equal((await importCodex(f.services, options)).skipped, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
});

test('equal text is overlap evidence only; distinct source identities retain both conversations', async t => {
  const f = await fixture(t), options = { ...f.options, importAttachments: false };
  assert.equal((await importCodex(f.services, options)).imported, 1);
  const preview = await importCodex(f.services, { ...options, sourceId: 'another-account', dryRun: true });
  assert.equal(preview.overlap.exactConversations, 1); assert.equal(preview.syncSummary.new, 1);
  assert.equal((await importCodex(f.services, { ...options, sourceId: 'another-account' })).imported, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
  const index = new OverlapIndex(); index.add({ id: 'short' }, [{ role: 'user', text: '你好' }]);
  assert.equal(index.compare([{ role: 'user', text: '你好' }]).exact.length, 0);
});

test('command preview exposes ChatGPT scope, overlap and exclusions; only the owner can confirm', async t => {
  const f = await fixture(t); await f.ctx.plugin(LocalJobs, {});
  let command;
  apply({ jobs: f.ctx.jobs, ...f.services, on() {}, commands: { register(definition) { command = definition; } } }, { importWorkspacePath: f.options.importWorkspacePath, importAttachments: false });
  const invoke = (rawInput, owner = 'owner') => command.handler({ rawInput, agent: { session: { id: owner } } });
  const finish = async receipt => {
    const id = /任务编号：(codex-import-[a-f0-9]+)/.exec(receipt.text)[1]; await f.ctx.jobs.wait(id, 10000);
    return latestProgress(f.ctx.jobs.readAt(id, 0).chunks.map(c => c.text).join(''));
  };
  assert.equal((await invoke('preview {"source":"unknown"}')).kind, 'error');
  assert.equal((await invoke('preview {"reviewedArchiveFingerprint":"fake"}')).kind, 'error');
  const preview = await finish(await invoke('preview ' + JSON.stringify({ source: 'chatgpt', archivePath: f.path })));
  assert.equal(preview.sourceKind, 'chatgpt'); assert.equal(preview.sourceSummary.conversations, 1); assert.equal(preview.sourceSummary.unsupported.length, 3);
  assert.equal(preview.importProposal.sourceHome, await realpath(f.path)); assert.equal(preview.overlap.scanned, 0);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 0);
  const confirmation = 'import-confirm ' + JSON.stringify({ token: preview.importProposal.token });
  assert.equal((await invoke(confirmation, 'other')).kind, 'error');
  const imported = await finish(await invoke(confirmation)); assert.equal(imported.imported, 1);
  assert.equal((await invoke(confirmation)).kind, 'error');
});

test('unknown/hidden/history content and assistant file attachments retain safe native projections', async t => {
  const f = await fixture(t, c => {
    c.mapping.r.message.content = { content_type: 'reasoning_recap', content: '导出的摘要' };
    c.mapping.a.message.metadata = { attachments: [{ id: 'file-pdf', name: 'assistant-report.pdf', mime_type: 'application/pdf' }] };
    c.mapping.history = node('history', 'a', 'system', { content_type: 'unknown-format', custom: '原始内容' });
    c.mapping.hidden = node('hidden', 'history', 'assistant', { content_type: 'text', parts: ['隐藏消息'] }, { is_visually_hidden_from_conversation: true });
    c.current_node = 'hidden'; return c;
  });
  assert.equal((await importCodex(f.services, f.options)).imported, 1);
  const { stored, events } = await readSession(f); validate(stored.header, events);
  assert.equal(events.filter(e => e.type === 'codex-import/files').length, 1);
  const cards = events.find(e => e.type === 'codex-import/files').data.files;
  assert.equal(cards[0].attachment.name, 'assistant-report.pdf');
  assert.ok(!eventMessages(events).some(m => m.text.includes('隐藏消息')));
  assert.equal(events.filter(e => e.type === 'system/message').length, 1);
  assert.ok(JSON.stringify(events).includes('unknown-format')); assert.ok(JSON.stringify(events).includes('隐藏消息'));
});

test('partial initial imports resume their exact prefix and duplicate IDs cannot create ambiguous copies', async t => {
  const f = await fixture(t), source = await new ChatGPTSource(f.path).open();
  const snapshot = await source.read(source.list()[0]); source.close(); snapshot.destinationCwd = f.options.importWorkspacePath;
  const converted = convertSnapshot(snapshot.source.sourceId, snapshot, SESSION_FORMAT_VERSION);
  const writer = await f.ctx.sessionPersistence.create(converted.header); await writer.append(converted.events.slice(0, 4)); await writer.close();
  const report = await importCodex(f.services, { ...f.options, importAttachments: false }); assert.equal(report.recovered, 1); assert.deepEqual(report.failed, []);
  const { stored, events } = await readSession(f); assert.deepEqual(events, converted.events); validate(stored.header, events);
  await writeFile(join(f.directory, 'conversations-001.json'), JSON.stringify([f.c]));
  await assert.rejects(new ChatGPTSource(f.directory).open(), /重复会话 ID/);
});
