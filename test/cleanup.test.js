import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import { apply } from '../src/index.js';
import { importCodex } from '../src/importer.js';
import { CleanupPlans, deleteImported } from '../src/cleanup.js';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'codex-cleanup-test-'));
  const root = await realpath(folder);
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, '.codex'); const sessionRoot = join(root, 'harness-sessions');
  await mkdir(join(codexHome, 'sessions'), { recursive: true });
  const original = [];
  for (const id of ['one', 'two']) {
    const path = join(codexHome, 'sessions', `${id}.jsonl`);
    const content = [
      { type: 'session_meta', payload: { id, cwd: root, title: '中文\u2028跨行\u2029标题', timestamp: '2026-11-01T00:00:00Z' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `原始问题 ${id}` }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '原始回答' }] } },
    ].map(JSON.stringify).join('\n');
    await writeFile(path, content); original.push({ path, content });
  }
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Jsonl, { root: sessionRoot, compression: 'zstd' });
  const members = new Set(), archived = new Set(), pinned = new Set();
  const workspace = { id: 'group', get sessionIds() { return [...members]; }, async attachSession(id) { members.add(id); }, async detachSession(id) { members.delete(id); } };
  const registry = {
    async create() { return workspace; }, list: () => [workspace],
    get archivedSessionIds() { return [...archived]; }, get pinnedSessionIds() { return [...pinned]; },
    async archiveSession(id) { archived.add(id); pinned.delete(id); }, async unarchiveSession(id) { archived.delete(id); },
    async pinSession(id) { pinned.add(id); }, async unpinSession(id) { pinned.delete(id); },
  };
  const services = { sessionPersistence: ctx.sessionPersistence, workspaceRegistry: registry, agents: { get() {} }, formatVersion: SESSION_FORMAT_VERSION };
  const result = await importCodex(services, { codexHome, importWorkspacePath: join(root, 'imports'), dryRun: false });
  assert.deepEqual(result.failed, []);
  const imported = await ctx.sessionPersistence.list();
  const first = imported[0]; const second = imported[1];
  const writer = await ctx.sessionPersistence.open(second.header.id, 'write');
  const events = (await writer.read()).events;
  let seq = events.length;
  const turn = Math.max(...events.filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1;
  const add = (type, data, extra = {}) => ({ seq: seq++, time: Date.now(), type, data, ...extra });
  await writer.append([add('turn/start', { turn }), add('step/start', { turn, step: 1 }),
    add('user/message', { id: 'continued', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Harness 新增续聊' }] }, { surfaceOp: 'append' }),
    add('step/end', { turn, step: 1 }), add('turn/end', { turn, reason: { kind: 'completed' } })]);
  await writer.close();
  const reader = await ctx.sessionPersistence.open(first.header.id, 'read');
  const sourceEvents = (await reader.read()).events; await reader.close();
  // A manually forked/copied transcript has a new identity and must stay out.
  const forkId = `codex-${'a'.repeat(24)}-${'b'.repeat(24)}`;
  const fork = await ctx.sessionPersistence.create({ ...first.header, id: forkId });
  await fork.append(sourceEvents); await fork.close(); members.add(forkId);
  const native = await ctx.sessionPersistence.create({ ...first.header, id: 'manual-native-chat' });
  await native.append([{ seq: 0, time: Date.now(), type: 'test/manual', data: {}, ignorable: true }]);
  await native.close(); members.add('manual-native-chat');
  return { root, codexHome, sessionRoot, services, first, second, original, members, archived, pinned, forkId };
}

async function verifyOriginal(f) {
  for (const file of f.original) assert.equal(await readFile(file.path, 'utf8'), file.content);
}

test('delete preview is read-only, distinguishes continued copies, and excludes manual chats/forks', async t => {
  const f = await fixture(t);
  const before = await f.services.sessionPersistence.list();
  const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner', undefined);
  assert.equal(report.proposal.count, 2); assert.equal(report.proposal.continuedCount, 1); assert.equal(report.proposal.plainCount, 1);
  assert.equal(report.failed.length, 0);
  assert.equal((await f.services.sessionPersistence.list()).length, before.length);
  assert.equal(f.archived.size, 0); await verifyOriginal(f);
});

test('confirmation is explicit, scope-specific, one-use and session-bound', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner'); const token = report.proposal.token;
  assert.throws(() => plans.confirm(token, 'other', false, '删除 1 条会话'), /失效/);
  assert.throws(() => plans.confirm(token, 'owner', false, '确认'), /不匹配/);
  assert.throws(() => plans.confirm(token, 'owner', true, '删除 1 条会话'), /不匹配/);
  const plan = plans.confirm(token, 'owner', false, '删除 1 条会话');
  assert.equal(plan.entries.length, 1); assert.equal(plan.preserved, 1);
  assert.throws(() => plans.confirm(token, 'owner', false, '删除 1 条会话'), /失效/);
  assert.ok(await f.services.sessionPersistence.stat(f.first.header.id));
});

test('confirmed default cleanup removes only imported copies without continued content', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner');
  const plan = plans.confirm(report.proposal.token, 'owner', false, '删除 1 条会话');
  const result = await deleteImported(f.services, plan);
  assert.equal(result.deleted, 1); assert.equal(result.preserved, 1); assert.deepEqual(result.failed, []);
  assert.equal(await f.services.sessionPersistence.stat(f.first.header.id), undefined);
  assert.ok(await f.services.sessionPersistence.stat(f.second.header.id));
  assert.ok(await f.services.sessionPersistence.stat(f.forkId));
  assert.ok(await f.services.sessionPersistence.stat('manual-native-chat'));
  assert.ok(f.members.has(f.second.header.id)); assert.ok(!f.members.has(f.first.header.id));
  await verifyOriginal(f);
});

test('including continued copies deletes all plugin copies while preserving native/forked sessions and Codex', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner');
  const result = await deleteImported(f.services, plans.confirm(report.proposal.token, 'owner', true, '删除 2 条会话'));
  assert.equal(result.deleted, 2); assert.deepEqual(result.failed, []);
  const ids = (await f.services.sessionPersistence.list()).map(row => row.header.id);
  assert.deepEqual(new Set(ids), new Set([f.forkId, 'manual-native-chat']));
  await verifyOriginal(f);
});

test('new messages after preview invalidate the whole reviewed scope before deletion', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner');
  const plan = plans.confirm(report.proposal.token, 'owner', true, '删除 2 条会话');
  const writer = await f.services.sessionPersistence.open(f.first.header.id, 'write');
  const events = (await writer.read()).events;
  await writer.append([{ seq: events.length, time: Date.now(), type: 'test/changed', data: {}, ignorable: true }]); await writer.close();
  await assert.rejects(deleteImported(f.services, plan), /发生变化/);
  assert.equal(f.archived.size, 0);
  assert.ok(await f.services.sessionPersistence.stat(f.first.header.id));
  assert.ok(await f.services.sessionPersistence.stat(f.second.header.id)); await verifyOriginal(f);
});

test('an active writer prevents removal and archive/pin state is restored', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  f.pinned.add(f.first.header.id);
  const report = await plans.scan(f.services, 'owner');
  const plan = plans.confirm(report.proposal.token, 'owner', false, '删除 1 条会话');
  const writer = await f.services.sessionPersistence.open(f.first.header.id, 'write');
  t.after(() => writer.close());
  const result = await deleteImported(f.services, plan);
  assert.equal(result.deleted, 0); assert.equal(result.failed.length, 1);
  assert.ok(await f.services.sessionPersistence.stat(f.first.header.id));
  assert.ok(!f.archived.has(f.first.header.id)); assert.ok(f.pinned.has(f.first.header.id)); await verifyOriginal(f);
});

test('unexpected files cause preservation instead of recursive directory deletion', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const directory = (await import('node:path')).dirname(f.first.location.path);
  await writeFile(join(directory, 'manual-note.txt'), '保留用户文件');
  const report = await plans.scan(f.services, 'owner');
  assert.equal(report.proposal.count, 1); assert.equal(report.failed.length, 1);
  assert.equal(await readFile(join(directory, 'manual-note.txt'), 'utf8'), '保留用户文件'); await verifyOriginal(f);
});

test('Codex source paths are rejected even when made to resemble imported session storage', async t => {
  const f = await fixture(t);
  const reader = await f.services.sessionPersistence.open(f.first.header.id, 'read');
  const events = (await reader.read()).events; await reader.close();
  const dir = join(f.codexHome, 'fake-project', f.first.header.id); await mkdir(dir, { recursive: true });
  const path = join(dir, 'session.v4.jsonl');
  const text = [{ type: 'session', ...f.first.header }, ...events].map(JSON.stringify).join('\n');
  await writeFile(path, text);
  const fake = { ...f.services, sessionPersistence: { async list() { return [{ ...f.first, location: { kind: 'jsonl', path } }]; } } };
  const report = await new CleanupPlans(f.codexHome).scan(fake, 'owner');
  assert.equal(report.proposal.count, 0); assert.equal(report.failed.length, 1);
  assert.equal(await readFile(path, 'utf8'), text); await verifyOriginal(f);
});


test('live registry agents are preserved without invoking unsupported disposal capabilities', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner');
  f.services.agents.get = id => id === f.first.header.id ? { id, cancel() {} } : undefined;
  const result = await deleteImported(f.services, plans.confirm(report.proposal.token, 'owner', false, '删除 1 条会话'));
  assert.equal(result.deleted, 0); assert.match(result.failed[0].error, /已在本次进程激活/);
  assert.equal(f.archived.size, 0); assert.ok(await f.services.sessionPersistence.stat(f.first.header.id)); await verifyOriginal(f);
});

test('cancellation between deletions preserves remaining copies and all Codex originals', async t => {
  const f = await fixture(t); const plans = new CleanupPlans(f.sessionRoot);
  const report = await plans.scan(f.services, 'owner'); const control = new AbortController();
  await assert.rejects(deleteImported(f.services, plans.confirm(report.proposal.token, 'owner', true, '删除 2 条会话'), control.signal,
    state => { if (state.deleted === 1) control.abort(); }), /abort/i);
  const remaining = (await f.services.sessionPersistence.list()).filter(row => [f.first.header.id, f.second.header.id].includes(row.header.id));
  assert.equal(remaining.length, 1); await verifyOriginal(f);
});

test('recovery copies belong to the original import scope and retain continuation detection', async t => {
  const f = await fixture(t);
  const reader = await f.services.sessionPersistence.open(f.second.header.id, 'read');
  const events = (await reader.read()).events; await reader.close();
  const id = 'codex-recovered-' + 'c'.repeat(24);
  const writer = await f.services.sessionPersistence.create({ ...f.second.header, id });
  await writer.append([...events, { seq: events.length, time: Date.now(), type: 'codex-import/recovery', ignorable: true,
    data: { sourceSessionId: f.second.header.id } }]); await writer.close();
  const plans = new CleanupPlans(f.sessionRoot); const report = await plans.scan(f.services, 'owner');
  assert.equal(report.proposal.count, 3); assert.equal(report.proposal.continuedCount, 2);
  const result = await deleteImported(f.services, plans.confirm(report.proposal.token, 'owner', true, '删除 3 条会话'));
  assert.equal(result.deleted, 3); assert.deepEqual(result.failed, []); await verifyOriginal(f);
});


test('host slash command runs a real scan job and requires confirmation before a delete job', async t => {
  const f = await fixture(t); const jobsCtx = new Context(); t.after(() => jobsCtx.fiber.dispose());
  await jobsCtx.plugin(LocalJobs, {}); let command;
  apply({ ...f.services, jobs: jobsCtx.jobs, on() {}, commands: { register(value) { command = value; } } }, { harnessSessionRoot: f.sessionRoot });
  const invoke = (rawInput, id = 'cleanup-control') => command.handler({ rawInput, agent: { session: { id } }, signal: new AbortController().signal });
  assert.match((await invoke('delete', f.first.header.id)).text, /新建/);
  assert.equal((await invoke('delete null')).kind, 'error');
  const receipt = await invoke('delete'); const id = /任务编号：(\S+)/.exec(receipt.text)[1];
  await jobsCtx.jobs.wait(id, 5000);
  const log = jobsCtx.jobs.readAt(id, 0).chunks.map(chunk => chunk.text).join('');
  const last = JSON.parse(log.trim().split('\n').at(-1));
  assert.equal(last.proposal.count, 2); assert.equal(last.phase, 'completed');
  const request = { token: last.proposal.token, includeContinued: true, confirmation: 'wrong' };
  assert.equal((await invoke('delete-confirm ' + JSON.stringify(request))).kind, 'error');
  assert.ok(await f.services.sessionPersistence.stat(f.first.header.id));
  request.confirmation = '删除 2 条会话';
  const deletion = await invoke('delete-confirm ' + JSON.stringify(request));
  const deleteId = /任务编号：(\S+)/.exec(deletion.text)[1]; await jobsCtx.jobs.wait(deleteId, 5000);
  assert.equal(jobsCtx.jobs.get(deleteId).status, 'completed');
  assert.equal(await f.services.sessionPersistence.stat(f.first.header.id), undefined);
  assert.equal(await f.services.sessionPersistence.stat(f.second.header.id), undefined); await verifyOriginal(f);
});
