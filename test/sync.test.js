import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Session, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { importCodex } from '../src/importer.js';
import { convertSnapshot } from '../src/convert.js';
import { CodexSource } from '../src/source.js';
import { buildSyncTransaction, importedState } from '../src/sync.js';
import { inspectImportedFile } from '../src/cleanup.js';
import { readImportedCatalog } from '../src/catalog.js';
import { ImportPlans } from '../src/import-plans.js';

async function fixture(t, metadataOnly = false) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sync-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex'), project = join(root, 'project'); await mkdir(home); await mkdir(project);
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at_ms INTEGER,archived INTEGER)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('one', '初始标题', project, 1000, 0); state.close();
  const history = join(home, 'thread_history_1.sqlite');
  const db = new DatabaseSync(history); db.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT)'); db.close();
  const item = (id, text, type = 'agentMessage', ordinal = 10) => {
    const db = new DatabaseSync(history); const value = type === 'userMessage' ? { type, id, content: [{ type: 'text', text }] } : { type, id, text, phase: 'final' };
    db.prepare('DELETE FROM thread_items WHERE thread_id=? AND item_id=?').run('one', id);
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('one', 'turn', id, ordinal, 1000 + ordinal, JSON.stringify(value)); db.close();
  };
  if (!metadataOnly) { item('q', '原始问题', 'userMessage', 1); item('a', '原始回答', 'agentMessage', 2); }
  const ctx = new Context(); await ctx.plugin(Jsonl, { root: join(root, 'target'), compression: 'zstd' }); t.after(() => ctx.fiber.dispose());
  const services = { sessionPersistence: ctx.sessionPersistence, formatVersion: SESSION_FORMAT_VERSION };
  const options = { codexHome: home, importAttachments: false, dryRun: false, importWorkspacePath: join(root, 'fallback') };
  const first = await importCodex(services, options); assert.deepEqual(first.failed, []);
  const stored = (await ctx.sessionPersistence.list())[0];
  const read = async () => { const r = await ctx.sessionPersistence.open(stored.header.id, 'read'); try { return (await r.read()).events; } finally { await r.close(); } };
  const snapshot = async () => { const s = await new CodexSource(home).open(); try { const snap = await s.read(s.list()[0]); snap.destinationCwd = project; return snap; } finally { s.close(); } };
  return { root, home, project, history, ctx, services, options, stored, item, read, snapshot };
}
function texts(events) { return events.flatMap(e => e.type === 'user/message' ? e.data.content : e.type === 'assistant/message' ? e.data.message.content : []).filter(b => b.type === 'text').map(b => b.text); }
function validate(header, events) {
  const s = new Session(header.id, events, header);
  assert.ok(s.deriveMessages().length);
  assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
}
async function harnessContinuation(f) {
  const events = await f.read(); const turn = events.reduce((n, e) => Math.max(n, Number(e.data?.turn) || 0), 0);
  const fake = { ...(await f.snapshot()), records: [
    { key: 'h-q', time: 9000, item: { type: 'userMessage', content: [{ type: 'text', text: 'Harness 续聊问题' }] } },
    { key: 'h-a', time: 9001, item: { type: 'agentMessage', text: 'Harness 续聊回答', phase: 'final' } },
  ], supplemental: [], suppressHead: true, skipLocationNotice: true, targetSessionId: f.stored.header.id };
  const appended = convertSnapshot(f.home, fake, SESSION_FORMAT_VERSION).events.filter(e => !['session/title', 'codex-import/source', 'codex-import/raw', 'codex-import/complete'].includes(e.type));
  appended.forEach((e, i) => { e.seq = events.length + i; if (e.data?.turn) e.data.turn += turn;
    if (e.type === 'user/message') e.data.id = 'native-harness-q'; if (e.type === 'assistant/message') e.data.message.id = 'native-harness-a'; });
  assert.deepEqual(appended, JSON.parse(JSON.stringify(appended)));
  const w = await f.ctx.sessionPersistence.open(f.stored.header.id, 'write'); await w.append(appended); await w.close();
}

test('sync appends new Codex messages to the same ID and preserves every Harness continuation event and byte', async t => {
  const f = await fixture(t); await harnessContinuation(f);
  const prefix = await f.read(); const bytes = await readFile(f.stored.location.path);
  f.item('new-q', 'Codex 新问题', 'userMessage', 3); f.item('new-a', 'Codex 新回答', 'agentMessage', 4);
  const preview = await importCodex(f.services, { ...f.options, dryRun: true });
  assert.equal(preview.syncSummary.changed, 1); assert.deepEqual(await readFile(f.stored.location.path), bytes);
  const result = await importCodex(f.services, f.options);
  assert.deepEqual(result.failed, []); assert.equal(result.updated, 1); assert.equal(result.imported, 0);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
  const after = await f.read(); assert.deepEqual(after.slice(0, prefix.length), prefix);
  assert.deepEqual((await readFile(f.stored.location.path)).subarray(0, bytes.length), bytes);
  for (const text of ['原始问题', '原始回答', 'Harness 续聊问题', 'Harness 续聊回答', 'Codex 新问题', 'Codex 新回答']) assert.equal(texts(after).filter(s => s === text).length, 1);
  validate(f.stored.header, after);
  assert.equal((await inspectImportedFile(f.stored.location.path, f.stored.header.id)).continued, true);
  const completed = await readFile(f.stored.location.path);
  const repeat = await importCodex(f.services, f.options); assert.equal(repeat.skipped, 1); assert.equal(repeat.updated, 0);
  assert.deepEqual(await readFile(f.stored.location.path), completed);
});

test('source edits and removals are recorded as revisions without deleting old or native content', async t => {
  const f = await fixture(t); await harnessContinuation(f);
  f.item('a', '修订后的回答', 'agentMessage', 2);
  const db = new DatabaseSync(f.history); db.prepare('DELETE FROM thread_items WHERE item_id=?').run('q'); db.close();
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []); assert.equal(result.updated, 1);
  const events = await f.read(); const all = texts(events);
  assert.ok(all.includes('原始问题')); assert.ok(all.includes('原始回答')); assert.ok(all.includes('修订后的回答')); assert.ok(all.includes('Harness 续聊回答'));
  assert.match(all.find(t => t.startsWith('【Codex 增量同步】')), /修订 1 条/);
  validate(f.stored.header, events);
  assert.equal((await importCodex(f.services, f.options)).skipped, 1);
});

test('repeated source edits and reversions get distinct native message IDs and preserve each revision', async t => {
  const f = await fixture(t);
  for (const text of ['版本 B', '原始回答', '版本 B']) {
    f.item('a', text, 'agentMessage', 2);
    const report = await importCodex(f.services, f.options); assert.deepEqual(report.failed, []); assert.equal(report.updated, 1);
  }
  const events = await f.read(); validate(f.stored.header, events);
  const ids = events.flatMap(e => e.type === 'user/message' ? [e.data.id] : e.type === 'assistant/message' ? [e.data.message.id] : []);
  assert.equal(new Set(ids).size, ids.length); assert.equal(texts(events).filter(text => text === '版本 B').length, 2);
  assert.equal((await importCodex(f.services, f.options)).skipped, 1);
});

test('metadata-only imports receive a recovered body in place and updated titles reach the catalog', async t => {
  const f = await fixture(t, true); f.item('q', '后来恢复的问题', 'userMessage', 1); f.item('a', '后来恢复的回答', 'agentMessage', 2);
  const state = new DatabaseSync(join(f.home, 'state_5.sqlite')); state.prepare('UPDATE threads SET title=?').run('Codex 新标题'); state.close();
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []); assert.equal(result.updated, 1);
  const events = await f.read(); assert.ok(texts(events).includes('后来恢复的回答')); validate(f.stored.header, events);
  const row = await readImportedCatalog(await f.ctx.sessionPersistence.stat(f.stored.header.id));
  assert.equal(row.title, 'Codex 新标题'); assert.equal(row.metadataOnly, false);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
});

test('manual Harness rename survives later source title changes', async t => {
  const f = await fixture(t); const w = await f.ctx.sessionPersistence.open(f.stored.header.id, 'write'); const events = (await w.read()).events;
  await w.append([{ seq: events.length, time: 8000, type: 'session/title', data: { title: '我在 Harness 命名', messageSeqs: [], source: { kind: 'user' } } }]); await w.close();
  const state = new DatabaseSync(join(f.home, 'state_5.sqlite')); state.prepare('UPDATE threads SET title=?').run('Codex 改了标题'); state.close();
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []);
  assert.equal((await f.read()).findLast(e => e.type === 'session/title').data.title, '我在 Harness 命名');
});

test('opened or busy chats are deferred without creating copies, and update after release', async t => {
  const f = await fixture(t); f.item('next', '稍后同步', 'agentMessage', 3);
  const before = await readFile(f.stored.location.path);
  const deferred = await importCodex({ ...f.services, sessions: { get: () => ({}) } }, f.options);
  assert.equal(deferred.deferred, 1); assert.equal(deferred.imported, 0); assert.deepEqual(deferred.failed, []);
  assert.deepEqual(await readFile(f.stored.location.path), before); assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
  assert.equal((await importCodex(f.services, f.options)).updated, 1);
});

test('legacy duplicates are retained while the copy containing Harness continuation becomes the stable sync target', async t => {
  const f = await fixture(t); await harnessContinuation(f);
  f.item('second', '新版源内容', 'agentMessage', 3);
  assert.equal((await importCodex(f.services, { ...f.options, syncExisting: false })).imported, 1);
  const copies = await f.ctx.sessionPersistence.list(); assert.equal(copies.length, 2);
  const other = copies.find(row => row.header.id !== f.stored.header.id); const otherBytes = await readFile(other.location.path);
  const synced = await importCodex(f.services, f.options); assert.deepEqual(synced.failed, []); assert.equal(synced.updated, 1);
  assert.ok(texts(await f.read()).includes('新版源内容')); assert.deepEqual(await readFile(other.location.path), otherBytes);
  f.item('third', '下一次更新', 'agentMessage', 4);
  assert.equal((await importCodex(f.services, f.options)).updated, 1);
  assert.ok(texts(await f.read()).includes('下一次更新')); assert.deepEqual(await readFile(other.location.path), otherBytes);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
});

test('an interrupted append resumes its exact plan before a newer source update, without duplicate messages', async t => {
  const f = await fixture(t); f.item('first-new', '第一批新增', 'agentMessage', 3);
  const events = await f.read(); const tx = buildSyncTransaction(f.stored.header, events, await f.snapshot(), SESSION_FORMAT_VERSION);
  const w = await f.ctx.sessionPersistence.open(f.stored.header.id, 'write');
  await w.append([tx.begin, ...tx.body.slice(0, 4)]); await w.close();
  f.item('second-new', '崩溃后新增', 'agentMessage', 4);
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []); assert.equal(result.updated, 1);
  const after = await f.read(); const all = texts(after);
  assert.equal(all.filter(s => s === '第一批新增').length, 1); assert.equal(all.filter(s => s === '崩溃后新增').length, 1);
  validate(f.stored.header, after); assert.equal(importedState(f.stored.header, after).pending, undefined);
  assert.equal((await inspectImportedFile(f.stored.location.path, f.stored.header.id)).continued, false);
});

test('confirmation freezes existing sync targets, includes latest source content, and excludes later new chats', async t => {
  const f = await fixture(t); f.item('new', '预览时的消息', 'agentMessage', 3);
  const preview = await importCodex(f.services, { ...f.options, dryRun: true });
  const plans = new ImportPlans(); const proposal = plans.create('owner', f.options, preview);
  f.item('new', '确认前最新消息', 'agentMessage', 3);
  const db = new DatabaseSync(join(f.home, 'state_5.sqlite'));
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('two', '预览后新增会话', f.project, 2000, 0); db.close();
  const options = plans.confirm(proposal.token, 'owner'); assert.equal(options.reviewedSyncTargets.one, f.stored.header.id);
  const result = await importCodex(f.services, { ...options, dryRun: false }); assert.deepEqual(result.failed, []);
  assert.equal(result.total, 1); assert.equal(result.updated, 1); assert.equal(result.imported, 0);
  assert.ok(texts(await f.read()).includes('确认前最新消息')); assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
  const next = await importCodex(f.services, f.options); assert.deepEqual(next.failed, []); assert.equal(next.imported, 1); assert.equal(next.skipped, 1);
  assert.equal((await f.ctx.sessionPersistence.list()).length, 2);
});

test('a conflicting interrupted transaction preserves native history and refuses a second copy', async t => {
  const f = await fixture(t); f.item('new', '新增消息', 'agentMessage', 3);
  const events = await f.read(); const tx = buildSyncTransaction(f.stored.header, events, await f.snapshot(), SESSION_FORMAT_VERSION);
  const w = await f.ctx.sessionPersistence.open(f.stored.header.id, 'write');
  await w.append([tx.begin, { seq: events.length + 1, time: 9999, type: 'session/title', data: { title: '意外的原生变更', messageSeqs: [], source: { kind: 'user' } } }]); await w.close();
  const before = await readFile(f.stored.location.path);
  const result = await importCodex(f.services, f.options); assert.equal(result.failed.length, 1); assert.match(result.failed[0].error, /冲突/);
  assert.deepEqual(await readFile(f.stored.location.path), before); assert.equal((await f.ctx.sessionPersistence.list()).length, 1);
});

test('JSONL-to-SQLite source upgrades do not append equivalent messages twice', async t => {
  const f = await fixture(t, true);
  await mkdir(join(f.home, 'sessions'));
  await writeFile(join(f.home, 'sessions', 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'one', cwd: f.project }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'JSONL 问题' }] }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'JSONL 回答' }] }, timestamp: '2026-01-01T00:00:02Z' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal((await importCodex(f.services, f.options)).updated, 1);
  f.item('q', 'JSONL 问题', 'userMessage', 1); f.item('a', 'JSONL 回答', 'agentMessage', 2); f.item('next', '真正的新增', 'agentMessage', 3);
  const result = await importCodex(f.services, f.options); assert.deepEqual(result.failed, []); assert.equal(result.updated, 1);
  const all = texts(await f.read());
  for (const text of ['JSONL 问题', 'JSONL 回答', '真正的新增']) assert.equal(all.filter(value => value === text).length, 1);
  assert.equal((await importCodex(f.services, f.options)).skipped, 1);
});
