import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ArchiveUploads, importSetup, installUploadRoutes } from '../src/uploads.js';
import { apply } from '../src/index.js';
import { Context } from '@deepseek-ai/cordis';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalJobs from '@deepseek-ai/dsh-jobs-local';
import { latestProgress } from '../src/client.js';

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(value), head = Buffer.alloc(30), row = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc32(bytes), 14);
    head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(filename.length, 26);
    row.writeUInt32LE(0x02014b50); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6); row.writeUInt16LE(0x800, 8); row.writeUInt32LE(crc32(bytes), 16);
    row.writeUInt32LE(bytes.length, 20); row.writeUInt32LE(bytes.length, 24); row.writeUInt16LE(filename.length, 28); row.writeUInt32LE(offset, 42);
    local.push(head, filename, bytes); central.push(row, filename); offset += head.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, end]);
}
const bytes = () => zip([['user.json', '{"id":"synthetic-account"}'], ['conversations.json', JSON.stringify([{ id: 'test-one', title: 'Synthetic export', create_time: 1, current_node: 'q',
  mapping: { q: { id: 'q', parent: null, message: { id: 'q', author: { role: 'user' }, content: { content_type: 'text', parts: ['Synthetic test message'] } } } } }])]]);
async function fixture(t, maxBytes) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-test-')); const uploads = new ArchiveUploads(join(root, 'uploads'), maxBytes);
  t.after(async () => { await uploads.dispose(); await rm(root, { recursive: true, force: true }); }); return { root, uploads };
}
function stream(data) { return (async function* () { for (let i = 0; i < data.length; i += 31) yield data.subarray(i, i + 31); })(); }

test('staging is streamed, binds tokens to their owner, protects leases and removes completed archives', async t => {
  const { root, uploads } = await fixture(t); const data = bytes();
  const staged = await uploads.stage('owner', '中文 export.zip', stream(data));
  assert.equal(staged.size, data.length); assert.ok(!Object.hasOwn(staged, 'path'));
  assert.throws(() => uploads.get(staged.id, 'other'), /失效/);
  const lease = uploads.acquire(staged.id, 'owner'); assert.deepEqual(await readFile(lease.path), data);
  await uploads.remove(staged.id, 'owner'); assert.ok(await stat(lease.path));
  await lease.release(); await assert.rejects(stat(lease.path), /ENOENT/);
  assert.deepEqual(await readdir(join(root, 'uploads')), []);
});

test('invalid, oversized, interrupted and expired uploads leave no temporary ZIPs', async t => {
  const { root, uploads } = await fixture(t, 2048);
  await assert.rejects(uploads.stage('owner', 'bad.zip', stream(Buffer.from('not a zip'))));
  await assert.rejects(uploads.stage('owner', 'wrong.zip', stream(zip([['other.json', '{}']]))), /没有 ChatGPT/);
  await assert.rejects(uploads.stage('owner', 'huge.zip', stream(Buffer.alloc(2049))), /大小限制/);
  await assert.rejects(uploads.stage('owner', 'wrong.txt', stream(bytes())), /ZIP/);
  const abort = new AbortController();
  const interrupted = (async function* () { yield bytes().subarray(0, 20); abort.abort(new Error('cancelled')); yield Buffer.from('tail'); })();
  await assert.rejects(uploads.stage('owner', 'cancelled.zip', interrupted, abort.signal), /cancelled/);
  assert.deepEqual(await readdir(join(root, 'uploads')), []);
  const staged = await uploads.stage('owner', 'valid.zip', stream(bytes())); const entry = uploads.get(staged.id, 'owner'); entry.expiresAt = 0;
  await uploads.sweep(); assert.deepEqual(await readdir(join(root, 'uploads')), []);
});

test('old crash leftovers are collected while source discovery does not create directories', async t => {
  const { root, uploads } = await fixture(t);
  await mkdir(join(root, 'uploads', 'upload-old123'), { recursive: true }); const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(join(root, 'uploads', 'upload-old123'), old, old);
  const staged = await uploads.stage('owner', 'valid.zip', stream(bytes())); assert.equal((await readdir(join(root, 'uploads'))).length, 1);
  await uploads.remove(staged.id, 'owner');
  const home = join(root, 'codex'); await mkdir(join(home, 'sessions'), { recursive: true });
  const config = await importSetup({ codexHome: home }); assert.ok(config.codexSources.some(row => row.path.endsWith('/codex')));
  await assert.rejects(stat(join(root, 'missing')), /ENOENT/);
});

test('upload route uses the authenticated streaming carrier and supports cancellation and release', async t => {
  const { uploads } = await fixture(t); const routes = new Map(), lifetime = new AbortController();
  const dispose = installUploadRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } } }, uploads, {}, lifetime.signal);
  t.after(dispose); const route = routes.get('/api/codex-import/upload'); assert.equal(route.requestBody, 'streaming');
  const response = await route.fetch(new Request('http://dsh/api/codex-import/upload?sessionId=owner&name=export.zip', { method: 'POST', body: bytes() }));
  assert.equal(response.status, 200); const staged = await response.json();
  const denied = await route.fetch(new Request(`http://dsh/api/codex-import/upload?sessionId=other&id=${staged.id}`, { method: 'DELETE' })); assert.equal(denied.status, 410);
  const removed = await route.fetch(new Request(`http://dsh/api/codex-import/upload?sessionId=owner&id=${staged.id}`, { method: 'DELETE' })); assert.equal(removed.status, 200);
});

test('unloading aborts a stalled streaming upload and removes its partial file', async t => {
  const { root, uploads } = await fixture(t); let started;
  const gate = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); } });
  const pending = uploads.stage('owner', 'stalled.zip', body);
  const rejected = assert.rejects(pending, /abort|关闭/i);
  await gate; await uploads.dispose(); await rejected;
  assert.deepEqual(await readdir(join(root, 'uploads')), []);
});

test('disposing fetch routes aborts pending uploads independently of host disposal order', async t => {
  const { root, uploads } = await fixture(t); let route, started;
  const gate = new Promise(resolve => { started = resolve; });
  const dispose = installUploadRoutes({ connection: { fetch: { register(value) { if (value.path.endsWith('/upload')) route = value; return () => {}; } } } }, uploads, {}, new AbortController().signal);
  const body = new ReadableStream({ pull() { started(); } });
  const pending = route.fetch(new Request('http://dsh/api/codex-import/upload?sessionId=owner&name=stalled.zip', { method: 'POST', body, duplex: 'half' }));
  await gate; await dispose(); assert.equal((await pending).status, 400);
  assert.deepEqual(await readdir(join(root, 'uploads')), []);
});

test('wizard command and uploaded ZIP preview stay read-only, confirmation imports then removes staging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-integration-')), oldHome = process.env.DSH_HOME; process.env.DSH_HOME = root;
  const ctx = new Context(), routes = new Map(), releases = []; let command, disposeHost;
  t.after(async () => { await disposeHost?.(); for (const release of releases) await release?.(); await ctx.fiber.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' }); await ctx.plugin(LocalJobs, {});
  apply({ jobs: ctx.jobs, sessionPersistence: ctx.sessionPersistence, connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    commands: { register(definition) { command = definition; } }, effect(fn) { releases.push(fn()); }, on(event, fn) { if (event === 'dispose') disposeHost = fn; } }, { importAttachments: false });
  const invoke = (rawInput, owner = 'owner') => command.handler({ rawInput, agent: { session: { id: owner } } });
  const finish = async result => { const id = /任务编号：(codex-import-[a-f0-9]+)/.exec(result.text)[1]; await ctx.jobs.wait(id, 10000);
    return latestProgress(ctx.jobs.readAt(id, 0).chunks.map(c => c.text).join('')); };
  assert.match((await invoke('preview')).text, /导入向导/); assert.equal((await ctx.sessionPersistence.list()).length, 0);
  await assert.rejects(stat(join(root, 'cache')), /ENOENT/);
  const staged = await (await routes.get('/api/codex-import/upload').fetch(new Request('http://dsh/api/codex-import/upload?sessionId=owner&name=export.zip', { method: 'POST', body: bytes() }))).json();
  const input = 'preview ' + JSON.stringify({ source: 'chatgpt', uploadToken: staged.id });
  assert.equal((await invoke(input, 'other')).kind, 'error');
  const preview = await finish(await invoke(input)); assert.equal(preview.importProposal.count, 1);
  assert.equal((await ctx.sessionPersistence.list()).length, 0);
  const confirm = 'import-confirm ' + JSON.stringify({ token: preview.importProposal.token });
  await invoke('preview'); assert.equal((await invoke(confirm)).kind, 'error');
  const fresh = await finish(await invoke(input));
  const imported = await finish(await invoke('import-confirm ' + JSON.stringify({ token: fresh.importProposal.token })));
  assert.equal(imported.imported, 1); assert.equal((await ctx.sessionPersistence.list()).length, 1);
  assert.deepEqual(await readdir(join(root, 'cache', 'codex-import', 'uploads')), []);
});
