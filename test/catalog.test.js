import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { convertSnapshot } from '../src/convert.js';
import { ImportCatalog, installCatalogRoute, warmNativeCache } from '../src/catalog.js';

async function harness(root) {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(StorageJson, { root: join(root, 'storage') });
  await ctx.plugin(StorageDomain, { backend: 'json' });
  await ctx.plugin(SessionStore); await ctx.plugin(ProjectionRegistry);
  await ctx.sessionProjections.register({ key: 'title', stateVersion: 1, stateSchema: z.string().nullable(), init: () => null,
    apply: (state, event) => event.type === 'session/title' ? event.data.title : state,
    wire: { viewSchema: z.string().nullable(), view: state => state } });
  await ctx.plugin(ProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60000 });
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' });
  return ctx;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-catalog-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await harness(root); t.after(() => ctx.fiber.dispose());
  const expected = [];
  for (const [id, cwd, title] of [['one', '/old/project-a', '会话一\u2028中文'], ['two', '/old/project-b', '会话二']]) {
    const converted = convertSnapshot('/source/.codex', { thread: { id, cwd, title }, destinationCwd: '/imports/codex',
      fingerprint: id === 'one' ? 'a'.repeat(64) : 'b'.repeat(64), mode: 'sqlite', createdAt: 1,
      records: [{ key: id, time: 2, item: { type: 'userMessage', content: [{ type: 'input_text', text: '问题' }] } }], supplemental: [], turns: [] }, SESSION_FORMAT_VERSION);
    const writer = await ctx.sessionPersistence.create(converted.header); await writer.append(converted.events); await writer.close();
    expected.push(converted);
  }
  const services = { warmCache: (header, events, signal) => warmNativeCache(ctx, header, events, signal), sessionPersistence: ctx.sessionPersistence, sessionProjectionCache: ctx.sessionProjectionCache,
    workspaceRegistry: { archivedSessionIds: [expected[1].header.id], pinnedSessionIds: [expected[0].header.id] } };
  return { root, ctx, services, expected };
}

async function settleCache(ctx, id) {
  const end = Date.now() + 2000;
  while (!ctx.sessionProjectionCache.cachedSnapshot((await ctx.sessionPersistence.stat(id)).header)?.values.title) {
    if (Date.now() > end) throw new Error('native title cache did not become durable');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('existing copies get project groups and durable native titles without opening or rewriting a chat', async t => {
  const f = await fixture(t); const catalog = new ImportCatalog(f.services);
  const before = await Promise.all(f.expected.map(async entry => {
    const snapshot = await f.ctx.sessionPersistence.stat(entry.header.id); return [snapshot.location.path, await readFile(snapshot.location.path)];
  }));
  for (const entry of f.expected) assert.equal(f.ctx.sessionProjectionCache.cachedSnapshot(entry.header), undefined);
  const result = await catalog.ensure();
  assert.equal(result.loading, false); assert.equal(result.errors.length, 0); assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items.map(row => row.projectTitle)), new Set(['project-a', 'project-b']));
  assert.ok(result.items.every(row => !row.originalCwd.startsWith('/imports')));
  assert.equal(result.items.find(row => row.id === f.expected[1].header.id).archived, true);
  for (const entry of f.expected) await settleCache(f.ctx, entry.header.id);
  assert.equal(f.ctx.sessionProjectionCache.cachedSnapshot(f.expected[0].header).values.title, '会话一\u2028中文');
  assert.equal(f.ctx.sessions.get(f.expected[0].header.id), undefined);
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes);
  await f.ctx.fiber.dispose();
  const cold = await harness(f.root); t.after(() => cold.fiber.dispose());
  assert.equal(cold.sessionProjectionCache.cachedSnapshot(f.expected[1].header).values.title, '会话二');
});

test('catalog refresh follows renames and deletions, and excludes native/manual forks', async t => {
  const f = await fixture(t); const catalog = new ImportCatalog(f.services);
  await catalog.ensure();
  const forkId = `codex-${'c'.repeat(24)}-${'d'.repeat(24)}`;
  const fork = await f.ctx.sessionPersistence.create({ ...f.expected[0].header, id: forkId });
  await fork.append(f.expected[0].events); await fork.close();
  const writer = await f.ctx.sessionPersistence.open(f.expected[0].header.id, 'write');
  const rows = (await writer.read()).events;
  await writer.append([{ seq: rows.length, time: 10, type: 'session/title', data: { title: 'Harness 新名称', messageSeqs: [], source: { kind: 'user' } } }]);
  await writer.close();
  const deleted = await f.ctx.sessionPersistence.stat(f.expected[1].header.id); await unlink(deleted.location.path);
  catalog.invalidate(); const next = await catalog.ensure();
  assert.equal(next.items.length, 1); assert.equal(next.items[0].title, 'Harness 新名称');
  assert.equal(next.errors.length, 0);
});

test('catalog route is read-only and immediately reports loading state using the native Fetch carrier', async () => {
  let route, resolve;
  const pending = new Promise(done => { resolve = done; });
  const catalog = { ensure: () => pending, snapshot: () => ({ loading: true, processed: 0, total: 1379, items: [] }) };
  const dispose = () => {};
  assert.equal(installCatalogRoute({ connection: { fetch: { register(value) { route = value; return dispose; } } } }, catalog), dispose);
  assert.deepEqual(route.methods, ['GET']);
  const response = await route.fetch(new Request('http://localhost/api/codex-import/catalog'));
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).loading, true); resolve();
});
