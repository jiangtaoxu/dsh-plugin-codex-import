import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as SessionPlugin from '@deepseek-ai/dsh-session';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream';
import * as Plugin from '../src/index.js';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import { latestProgress } from '../src/client.js';
import { CodexSource } from '../src/source.js';
import { convertSnapshot, sessionIdFor } from '../src/convert.js';
import { importCodex } from '../src/importer.js';

const time = 1794270000000;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex');
  const project = join(root, '中文 project');
  await mkdir(home); await mkdir(project);
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at_ms INTEGER,archived INTEGER,is_pinned INTEGER,model TEXT,model_provider TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,path TEXT);`);
  for (const [id, title, archived, pinned] of [['one', '中文对话', 0, 1], ['empty', '仅剩标题', 1, 0]]) {
    state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, title, project, time, archived, pinned, 'original-model', 'original-provider');
  }
  state.close();
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  history.exec(`CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT);
    CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT);
    CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT);`);
  const values = [
    { type: 'userMessage', id: 'q', content: [{ type: 'text', text: '你好\n第二行' }, { type: 'localImage', path: '/original/image.png' }] },
    { type: 'reasoning', id: 'r', summary: ['分析摘要'], content: ['分析内容'] },
    { type: 'commandExecution', id: 'c', command: 'echo test', cwd: project, aggregatedOutput: 'test\n', exitCode: 0, status: 'completed' },
    { type: 'agentMessage', id: 'a', text: '完成 ✅', phase: 'final' },
  ];
  for (const [ordinal, item] of values.entries()) history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)')
    .run('one', 'turn-one', item.id, ordinal, time + ordinal, JSON.stringify(item));
  history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run('one', 'turn-one', 0, 'completed');
  history.close();
  return { root, home, project, values };
}

async function backend(t, root, compression = 'none') {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Jsonl, { root, compression });
  return ctx;
}

function workspaces() {
  const groups = new Map();
  const archived = new Set();
  const pinned = new Set();
  return { groups, archived, pinned, async create(path) {
    if (!groups.has(path)) groups.set(path, { id: path, members: new Set(), async attachSession(id) { this.members.add(id); } });
    return groups.get(path);
  }, async archiveSession(id) { archived.add(id); }, async pinSession(id) { pinned.add(id); } };
}

const services = (ctx, registry = workspaces()) => ({ sessionPersistence: ctx.sessionPersistence,
  formatVersion: SessionPlugin.SESSION_FORMAT_VERSION, workspaceRegistry: registry });

test('preview reads SQLite, includes metadata-only rows, and does not write', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.home, 'state_5.sqlite'));
  const report = await importCodex({}, { codexHome: f.home });
  assert.equal(report.total, 2); assert.equal(report.withBody, 1); assert.equal(report.metadataOnly, 1);
  assert.equal(report.items, 4); assert.equal(report.imported, 0); assert.deepEqual(report.failed, []);
  assert.deepEqual(await readFile(join(f.home, 'state_5.sqlite')), before);
});

test('native backend reopens imported messages, source records and exact text', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  const registry = workspaces();
  const report = await importCodex(services(ctx, registry), { codexHome: f.home, groupByProject: true, dryRun: false });
  assert.deepEqual(report.failed, []); assert.equal(report.imported, 2);
  assert.equal(registry.groups.size, 1); assert.equal(registry.archived.size, 1); assert.equal(registry.pinned.size, 1);
  const snapshot = await ctx.sessionPersistence.list();
  assert.equal(snapshot.length, 2);
  const source = await new CodexSource(f.home).open();
  const imported = convertSnapshot(source.home, await source.read(source.list({ threadIds: ['one'] })[0]), SessionPlugin.SESSION_FORMAT_VERSION);
  source.close();
  const handle = await ctx.sessionPersistence.open(imported.header.id, 'read');
  const { events } = await handle.read();
  await handle.close();
  assert.deepEqual(events, imported.events);
  assert.equal(events.find(e => e.type === 'user/message').data.content[0].text, '你好\n第二行');
  assert.deepEqual(events.filter(e => e.type === 'codex-import/raw').map(e => e.data.item), f.values);
  for (const event of events.filter(e => e.type === 'assistant/message')) {
    assert.ok(expandAssistantStream(event.data.stream).length);
  }
  await ctx.plugin(SessionPlugin.default);
  const session = ctx.sessions.create(imported.header.id, { seed: events, meta: imported.header });
  assert.ok(session.deriveMessages().some(m => m.content.some(b => b.text === '完成 ✅')));
});

test('cold restart validates the current Harness format using zstd storage', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target');
  const ctx = await backend(t, target, 'zstd');
  const report = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false });
  assert.deepEqual(report.failed, []);
  const ids = (await ctx.sessionPersistence.list()).map(s => s.header.id);
  await ctx.fiber.dispose();
  const cold = await backend(t, target, 'zstd');
  for (const id of ids) {
    const reader = await cold.sessionPersistence.open(id, 'read');
    assert.equal((await reader.read()).events.at(-1).type, 'codex-import/complete');
    await reader.close();
  }
});

test('repeat imports skip completed snapshots and preserve chats continued in Harness', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  const first = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false });
  assert.equal(first.imported, 2);
  const id = (await ctx.sessionPersistence.list())[0].header.id;
  const writer = await ctx.sessionPersistence.open(id, 'write');
  const previous = (await writer.read()).events;
  await writer.append([{ seq: previous.length, time, type: 'test/continued', data: { text: 'keep' }, ignorable: true }]);
  await writer.close();
  const second = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false });
  assert.equal(second.skipped, 2); assert.equal(second.imported, 0); assert.deepEqual(second.failed, []);
  const reader = await ctx.sessionPersistence.open(id, 'read');
  assert.equal((await reader.read()).events.at(-1).type, 'test/continued'); await reader.close();
});

test('explicit snapshot mode keeps independent immutable versions', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, syncExisting: false, dryRun: false });
  const db = new DatabaseSync(join(f.home, 'thread_history_1.sqlite'));
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('one', 'turn-one', 'new', 5, time + 5,
    JSON.stringify({ type: 'agentMessage', id: 'new', text: '新增消息' })); db.close();
  const report = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, syncExisting: false, dryRun: false });
  assert.equal(report.imported, 1); assert.equal(report.skipped, 1);
  assert.equal((await ctx.sessionPersistence.list()).length, 3);
});

test('a crash prefix resumes without duplicate events', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  const source = await new CodexSource(f.home).open();
  const converted = convertSnapshot(source.home, await source.read(source.list({ threadIds: ['one'] })[0]), SessionPlugin.SESSION_FORMAT_VERSION);
  source.close();
  const writer = await ctx.sessionPersistence.create(converted.header);
  await writer.append(converted.events.slice(0, 6)); await writer.close();
  const report = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false, threadIds: ['one'] });
  assert.equal(report.recovered, 1); assert.deepEqual(report.failed, []);
  const reader = await ctx.sessionPersistence.open(converted.header.id, 'read');
  assert.deepEqual((await reader.read()).events, converted.events); await reader.close();
});

test('legacy JSONL avoids duplicate response/event messages, preserves raw data, reports a torn tail', async t => {
  const f = await fixture(t);
  const dir = join(f.home, 'archived_sessions'); await mkdir(dir);
  const rows = [
    { type: 'session_meta', timestamp: new Date(time).toISOString(), payload: { id: 'legacy', cwd: f.project } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'same question' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] } },
  ];
  await writeFile(join(dir, 'rollout.jsonl'), rows.map(JSON.stringify).join('\n') + '\n{"incomplete":');
  const source = await new CodexSource(f.home).open(); t.after(() => source.close());
  const thread = source.list({ threadIds: ['legacy'] })[0];
  assert.equal(thread.archived, 1);
  const snap = await source.read(thread);
  const converted = convertSnapshot(source.home, snap, SessionPlugin.SESSION_FORMAT_VERSION);
  assert.equal(snap.mode, 'jsonl'); assert.equal(source.warnings.length, 1);
  assert.equal(converted.events.filter(e => e.type === 'user/message').length, 1);
  assert.deepEqual(converted.events.filter(e => e.type === 'codex-import/raw').map(e => e.data.item), rows);
});

test('SQLite remains authoritative when a supplemental rollout also exists', async t => {
  const f = await fixture(t); const dir = join(f.home, 'sessions'); await mkdir(dir);
  await writeFile(join(dir, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'one', cwd: f.project } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate' }] } },
  ].map(JSON.stringify).join('\n'));
  const source = await new CodexSource(f.home).open(); t.after(() => source.close());
  const converted = convertSnapshot(source.home, await source.read(source.list({ threadIds: ['one'] })[0]), SessionPlugin.SESSION_FORMAT_VERSION);
  assert.equal(converted.events.filter(e => e.type === 'user/message').length, 1);
  assert.equal(converted.events.filter(e => e.type === 'codex-import/raw').length, 6);
});

test('project and archive filters work, orphaned history and realtime items survive', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.home, 'thread_history_1.sqlite'));
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('orphan', 't', 'o', 1, time,
    JSON.stringify({ type: 'agentMessage', text: '孤立记录' }));
  db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)').run('one', 'live', 9, time,
    JSON.stringify({ type: 'agentMessage', text: '正在输出' }));
  db.prepare('INSERT INTO thread_realtime_items VALUES(?,?,?,?,?)').run('realtime-orphan', 'live-only', 1, time,
    JSON.stringify({ type: 'agentMessage', text: '尚未投影的孤立消息' })); db.close();
  const source = await new CodexSource(f.home).open(); t.after(() => source.close());
  assert.equal(source.list({ cwd: f.project, includeArchived: false }).length, 1);
  assert.equal(source.list().length, 4);
  assert.equal((await source.read(source.list({ threadIds: ['one'] })[0])).records.length, 5);
  assert.equal((await source.read(source.list({ threadIds: ['realtime-orphan'] })[0])).mode, 'sqlite');
});

test('missing project directories do not prevent conversation persistence', async t => {
  const f = await fixture(t); await rm(f.project, { recursive: true });
  const ctx = await backend(t, join(f.root, 'target'));
  const fallback = join(f.root, '回退目录');
  const report = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, importWorkspacePath: fallback, dryRun: false });
  assert.equal(report.destinationSummary.fallbackSessions, 2);
  assert.ok((await ctx.sessionPersistence.list()).every(row => row.header.cwd === fallback));
  await assert.rejects(() => readdir(f.project), /ENOENT/);
  assert.equal(report.imported, 2); assert.equal(report.ungrouped, 0); assert.deepEqual(report.failed, []);
});

test('unified import groups different original directories under Codex 导入 and retains their paths', async t => {
  const f = await fixture(t);
  const state = new DatabaseSync(join(f.home, 'state_5.sqlite'));
  const missingOriginal = join(f.root, 'old-missing-project');
  state.prepare('UPDATE threads SET cwd=? WHERE id=?').run(missingOriginal, 'empty'); state.close();
  const target = join(f.root, 'target');
  const importWorkspacePath = join(f.root, 'Codex 导入');
  const ctx = await backend(t, target);
  const registry = workspaces();
  const report = await importCodex(services(ctx, registry), { codexHome: f.home, groupByProject: false, importWorkspacePath, dryRun: false });
  assert.equal(report.imported, 2); assert.equal(report.workspaces, 1); assert.equal(report.ungrouped, 0);
  assert.equal(registry.groups.size, 1); assert.equal(report.workspaceTitle, 'Codex 导入');
  assert.deepEqual(report.failed, []);
  const snapshots = await ctx.sessionPersistence.list();
  for (const stored of snapshots) {
    assert.equal(stored.header.cwd, report.importWorkspacePath);
    const reader = await ctx.sessionPersistence.open(stored.header.id, 'read');
    const events = (await reader.read()).events; await reader.close();
    const original = events.find(e => e.type === 'codex-import/source').data.metadata;
    assert.ok([f.project, missingOriginal].includes(original.cwd));
    assert.ok(events.some(e => e.type === 'assistant/message'
      && e.data.message.content.some(block => block.text?.includes(`原始工作目录：${original.cwd}`))));
  }
  const second = await importCodex(services(ctx, registry), { codexHome: f.home, groupByProject: false, importWorkspacePath, dryRun: false });
  assert.equal(second.skipped, 2);
  await ctx.fiber.dispose();
  const cold = await backend(t, target);
  for (const stored of await cold.sessionPersistence.list()) {
    const reader = await cold.sessionPersistence.open(stored.header.id, 'read');
    assert.equal((await reader.read()).events.at(-1).type, 'codex-import/complete'); await reader.close();
  }
});

test('preview and run immediately return jobs, require confirmation and freeze reviewed scope', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'confirmed-target'));
  await ctx.plugin(LocalJobs, {});
  let command;
  const host = { jobs: ctx.jobs, sessionPersistence: ctx.sessionPersistence, workspaceRegistry: workspaces(),
    on() {}, commands: { register(def) { command = def; } } };
  Plugin.apply(host, { codexHome: f.home, importWorkspacePath: join(f.root, 'workspace'), importAttachments: false });
  const invoke = (input, owner = 'owner') => command.handler({ rawInput: input, signal: new AbortController().signal, agent: { session: { id: owner } } });
  const finish = async receipt => {
    const id = /任务编号：(codex-import-[a-f0-9]+)/.exec(receipt.text)[1];
    await ctx.jobs.wait(id, 10000);
    return latestProgress(ctx.jobs.readAt(id, 0).chunks.map(c => c.text).join(''));
  };
  assert.equal((await invoke('run {"dryRun":false}')).kind, 'error');
  assert.equal((await invoke('run {"threadIds":123}')).kind, 'error');
  const receipt = await invoke('preview');
  assert.match(receipt.text, /Codex 预览任务/);
  assert.equal((await ctx.sessionPersistence.list()).length, 0);
  const preview = await finish(receipt);
  assert.equal(preview.phase, 'completed'); assert.equal(preview.importProposal.count, 2);
  assert.equal((await ctx.sessionPersistence.list()).length, 0);
  await assert.rejects(() => readdir(join(f.root, 'workspace')), /ENOENT/);
  const state = new DatabaseSync(join(f.home, 'state_5.sqlite'));
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run('new-after-preview', '不在确认范围', f.project, time, 0, 0, 'm', 'p'); state.close();
  const confirm = `import-confirm ${JSON.stringify({ token: preview.importProposal.token })}`;
  assert.equal((await invoke(confirm, 'wrong-owner')).kind, 'error');
  assert.equal((await invoke(confirm.replace('}', ',"cwd":"/elsewhere"}'))).kind, 'error');
  const imported = await finish(await invoke(confirm));
  assert.equal(imported.imported, 2); assert.equal(imported.total, 2);
  assert.equal((await ctx.sessionPersistence.list()).length, 2);
  assert.equal((await invoke(confirm)).kind, 'error');
  const run = await finish(await invoke('run {"threadIds":["new-after-preview"]}'));
  assert.equal(run.mode, 'preview'); assert.equal(run.importProposal.count, 1);
  assert.equal((await ctx.sessionPersistence.list()).length, 2);
});

test('cancellation aborts before any target write', async t => {
  const f = await fixture(t); const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(importCodex({}, { codexHome: f.home, groupByProject: true, dryRun: false }, abort.signal), /cancelled/);
  assert.deepEqual((await readdir(f.home)).sort(), ['state_5.sqlite', 'thread_history_1.sqlite']);
});

test('progress follows persisted threads and reports writing and grouping stages', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  const updates = [];
  await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false },
    undefined, update => updates.push(update));
  assert.equal(updates[0].phase, 'discovering'); assert.equal(updates[0].total, null);
  const completed = updates.filter(update => update.phase === 'processed');
  assert.deepEqual(completed.map(update => update.processed), [1, 2]);
  assert.ok(completed.every(update => update.total === 2));
  assert.equal(updates.at(-1).imported, 2);
  assert.ok(updates.some(update => update.phase === 'writing' && update.writtenEvents > 0));
  assert.ok(updates.some(update => update.phase === 'grouping'));
});

test('cancelling between threads keeps completed data and a subsequent run resumes', async t => {
  const f = await fixture(t);
  const ctx = await backend(t, join(f.root, 'target'));
  const cancellation = new AbortController();
  await assert.rejects(importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false },
    cancellation.signal, update => {
      if (update.phase === 'processed' && update.processed === 1) cancellation.abort(new Error('stop-between-threads'));
    }), /stop-between-threads/);
  assert.equal((await ctx.sessionPersistence.list()).length, 1);
  const resumed = await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false });
  assert.equal(resumed.skipped, 1); assert.equal(resumed.imported, 1); assert.deepEqual(resumed.failed, []);
});

test('new imports retain a protected system head when continued and cold reopened', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target');
  const ctx = await backend(t, target);
  await importCodex(services(ctx), { codexHome: f.home, groupByProject: true, dryRun: false, threadIds: ['one'] });
  const { header } = (await ctx.sessionPersistence.list())[0];
  const writer = await ctx.sessionPersistence.open(header.id, 'write');
  const initial = (await writer.read()).events;
  const head = initial.find(e => e.surfaceOp);
  assert.equal(head.type, 'system/message');
  let seq = initial.length;
  const add = (type, data, extra = {}) => ({ seq: seq++, time, type, data, ...extra });
  await writer.append([
    add('turn/start', { turn: 2 }), add('step/start', { turn: 2, step: 1 }),
    add('system/message', { turn: 2, step: 1, message: { id: 'new-system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Current host prompt' }] } },
      { surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] }),
    add('step/end', { turn: 2, step: 1 }), add('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]);
  await writer.close(); await ctx.fiber.dispose();
  const cold = await backend(t, target);
  const reader = await cold.sessionPersistence.open(header.id, 'read');
  assert.ok((await reader.read()).events.some(e => e.data?.message?.id === 'new-system'));
  await reader.close();
});

test('legacy continued imports recover into a new copy without rewriting the original', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target');
  const ctx = await backend(t, target);
  const source = await new CodexSource(f.home).open();
  const converted = convertSnapshot(source.home, await source.read(source.list({ threadIds: ['one'] })[0]), SessionPlugin.SESSION_FORMAT_VERSION);
  source.close();
  const legacy = converted.events.filter(e => e.type !== 'system/message').map((e, seq) => ({ ...e, seq }));
  let seq = legacy.length;
  const add = (type, data, extra = {}) => ({ seq: seq++, time, type, data, ...extra });
  legacy.push(add('turn/start', { turn: 2 }), add('step/start', { turn: 2, step: 1 }),
    add('system/message', { turn: 2, step: 1, message: { id: 'host-prompt', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Host prompt' }] } }, { surfaceOp: 'append' }),
    add('user/message', { id: 'continued-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我的续聊内容' }] }, { surfaceOp: 'append' }),
    add('step/end', { turn: 2, step: 1 }), add('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  const writer = await ctx.sessionPersistence.create(converted.header);
  await writer.append(legacy); await writer.close();
  const originalPath = (await ctx.sessionPersistence.stat(converted.header.id)).location.path;
  const originalBytes = await readFile(originalPath);
  const registry = workspaces();
  const result = await importCodex(services(ctx, registry), { codexHome: f.home, groupByProject: true, dryRun: false, threadIds: ['one'] });
  assert.deepEqual(result.failed, []); assert.equal(result.recovered, 1);
  assert.deepEqual(await readFile(originalPath), originalBytes);
  assert.ok(registry.archived.has(converted.header.id));
  const copy = (await ctx.sessionPersistence.list()).find(row => row.header.id !== converted.header.id);
  assert.ok(copy.header.id.startsWith('codex-recovered-'));
  await ctx.fiber.dispose();
  const cold = await backend(t, target);
  const reader = await cold.sessionPersistence.open(copy.header.id, 'read');
  const recovered = (await reader.read()).events; await reader.close();
  assert.equal(recovered.find(e => e.surfaceOp).type, 'system/message');
  assert.ok(recovered.some(e => e.data?.content?.[0]?.text === '我的续聊内容'));
  assert.equal(recovered.filter(e => e.type === 'user/message' || e.type === 'assistant/message').length,
    legacy.filter(e => e.type === 'user/message' || e.type === 'assistant/message').length);
});

test('native imports default to existing original directories, and new placement preserves unified copies and continuations', async t => {
  const f = await fixture(t); const ctx = await backend(t, join(f.root, 'target')); const registry = workspaces();
  const fallback = join(f.root, 'archive');
  await importCodex(services(ctx, registry), { codexHome: f.home, importWorkspacePath: fallback, groupByProject: false, importAttachments: false, dryRun: false });
  const old = await ctx.sessionPersistence.list(); const oldId = old[0].header.id;
  const writer = await ctx.sessionPersistence.open(oldId, 'write');
  await writer.append([{ seq: (await writer.read()).events.length, time: 2, type: 'codex-import/test-continued', data: {}, ignorable: true }]); await writer.close();
  const oldReader = await ctx.sessionPersistence.open(oldId, 'read'); const before = (await oldReader.read()).events; await oldReader.close();
  const preview = await importCodex({}, { codexHome: f.home, importWorkspacePath: fallback, importAttachments: false });
  assert.equal(preview.destinationSummary.originalSessions, 2); assert.equal((await ctx.sessionPersistence.list()).length, 2);
  const plans = new (await import('../src/import-plans.js')).ImportPlans();
  const proposal = plans.create('owner', { importAttachments: false }, preview);
  const options = plans.confirm(proposal.token, 'owner');
  const imported = await importCodex(services(ctx, registry), { ...options, dryRun: false });
  assert.equal(imported.imported, 2); assert.equal(imported.workspaces, 1); assert.equal(imported.destinationSummary.originalSessions, 2);
  const all = await ctx.sessionPersistence.list(); assert.equal(all.length, 4);
  assert.equal(all.filter(row => row.header.cwd === f.project).length, 2);
  const reader = await ctx.sessionPersistence.open(oldId, 'read'); assert.deepEqual((await reader.read()).events, before); await reader.close();
  assert.equal((await importCodex(services(ctx, registry), { codexHome: f.home, importWorkspacePath: fallback, importAttachments: false, dryRun: false })).skipped, 2);
});

test('a project removed after preview rejects confirmation before any session or attachment write', async t => {
  const f = await fixture(t); const ctx = await backend(t, join(f.root, 'target'));
  const options = { codexHome: f.home, importWorkspacePath: join(f.root, 'fallback'), importAttachments: false };
  const preview = await importCodex({}, options); const plans = new (await import('../src/import-plans.js')).ImportPlans();
  const proposal = plans.create('owner', options, preview); const frozen = plans.confirm(proposal.token, 'owner');
  await rm(f.project, { recursive: true });
  await assert.rejects(importCodex(services(ctx), { ...frozen, dryRun: false }), /工作目录已变化/);
  assert.equal((await ctx.sessionPersistence.list()).length, 0);
  await assert.rejects(() => readdir(options.importWorkspacePath), /ENOENT/);
});
