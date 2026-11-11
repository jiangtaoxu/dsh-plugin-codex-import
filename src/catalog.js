import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { jsonlLines } from './jsonl.js';
import { readZstdFrames } from './zstd.js';
import { IMPORT_ID, isImportedIdentity } from './identity.js';

/** Only read Harness copies. No source access, Agent activation or log rewriting. */
export async function readImportedCatalog(snapshot, cache, signal, warmCache) {
  const path = snapshot.location?.path;
  if (snapshot.location?.kind !== 'jsonl' || !path) return undefined;
  const cachedTitle = cache?.cachedSnapshot(snapshot.header)?.values?.title;
  const warm = !cachedTitle && !!cache;
  const chunks = path.endsWith('.zstd') ? readZstdFrames(path, signal) : createReadStream(path);
  let header, source, latestSync, recovery, title, time = snapshot.header.createdAt;
  const events = warm ? [] : undefined;
  try {
    for await (const line of jsonlLines(chunks)) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      if (!header) {
        header = JSON.parse(line);
        if (header.id !== snapshot.header.id || header.type !== 'session') return undefined;
        continue;
      }
      const type = /"type"\s*:\s*"([^"\\]+)"/.exec(line.slice(0, 256))?.[1];
      const event = warm || !source || ['session/title', 'codex-import/sync', 'codex-import/recovery', 'user/message'].includes(type) ? JSON.parse(line) : undefined;
      if (!source) {
        if (event?.type !== 'codex-import/source' || event.seq !== 0) return undefined;
        source = event.data;
      }
      if (event?.type === 'codex-import/sync') latestSync = event.data;
      if (event?.type === 'session/title') title = event.data.title;
      if (event?.type === 'codex-import/recovery') recovery = event.data.sourceSessionId;
      if (event?.type === 'user/message') time = Math.max(time, event.time);
      events?.push(event);
    }
  } finally { chunks.destroy?.(); await chunks.return?.(); }
  if (!source || !isImportedIdentity(header.id, source, recovery)) return undefined;
  if (events) {
    if (warmCache) await warmCache(snapshot.header, events, signal);
    else cache.coldSnapshot(snapshot.header, 0, events);
  }
  const metadata = latestSync?.metadata || source.metadata || {};
  const chatgpt = source.kind === 'chatgpt';
  const projectPath = metadata.project?.path || metadata.project?.cwd || metadata.cwd || '';
  const projectTitle = chatgpt ? 'ChatGPT 导入' : metadata.project?.title || metadata.project?.name || (projectPath ? basename(projectPath) : '未关联项目');
  return { id: header.id, threadId: source.threadId, sourceKind: chatgpt ? 'chatgpt' : 'codex', title: title?.trim() || metadata.title?.trim() || `${chatgpt ? 'ChatGPT' : 'Codex'} ${source.threadId}`,
    projectKey: chatgpt ? source.sourceId : projectPath || metadata.project?.id || '__unassigned', projectTitle, projectPath,
    originalCwd: metadata.cwd || '', attachmentImages: (latestSync?.attachments || source.attachments)?.images || 0, attachmentFiles: (latestSync?.attachments || source.attachments)?.files || 0, attachmentMissing: (latestSync?.attachments || source.attachments)?.missing || 0, createdAt: header.createdAt, updatedAt: time, metadataOnly: (latestSync?.mode || source.mode) === 'metadata-only' };
}

/** Revision-aware, bounded scan; refresh never activates thousands of Agents. */
export class ImportCatalog {
  constructor(services) {
    this.services = services; this.memo = new Map();
    this.state = { items: [], total: 0, processed: 0, loading: false, errors: [], refreshedAt: 0 };
  }
  snapshot() { return this.state; }
  invalidate() { this.state = { ...this.state, refreshedAt: 0 }; if (this.running) this.rescan = true; }
  ensure(signal, force = false) {
    if (this.running) { if (force) this.rescan = true; return this.running; }
    if (!force && this.state.refreshedAt && Date.now() - this.state.refreshedAt < 60000) return Promise.resolve(this.state);
    this.running = this.scan(signal).finally(() => {
      this.running = undefined;
      if (this.rescan && !signal?.aborted) {
        this.rescan = false;
        void this.ensure(signal, true).catch(() => {});
      }
    });
    return this.running;
  }
  async scan(signal) {
    const items = [], errors = [], next = new Map();
    this.state = { ...this.state, loading: true, processed: 0, errors: [] };
    try {
      const snapshots = (await this.services.sessionPersistence.list({ signal })).filter(row => IMPORT_ID.test(row.header.id));
      this.state = { ...this.state, total: snapshots.length };
      const archived = new Set(this.services.workspaceRegistry?.archivedSessionIds || []);
      const pinned = new Set(this.services.workspaceRegistry?.pinnedSessionIds || []);
      for (const snapshot of snapshots) {
        signal?.throwIfAborted();
        try {
          const old = this.memo.get(snapshot.header.id);
          const row = old?.revision === snapshot.revision ? old.row
            : await readImportedCatalog(snapshot, this.services.sessionProjectionCache, signal, this.services.warmCache);
          next.set(snapshot.header.id, { revision: snapshot.revision, row });
          if (row) items.push({ ...row, archived: archived.has(row.id), pinned: pinned.has(row.id) });
        } catch (error) {
          signal?.throwIfAborted();
          errors.push({ id: snapshot.header.id, message: error.message });
        }
        this.state = { ...this.state, processed: this.state.processed + 1 };
        await new Promise(resolve => setImmediate(resolve));
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      this.memo = next;
      this.state = { items, total: snapshots.length, processed: snapshots.length, errors, loading: false, refreshedAt: Date.now() };
    } catch (error) {
      this.state = { ...this.state, loading: false, errors: [{ message: error.message }], refreshedAt: 0 };
      throw error;
    }
    return this.state;
  }
}

/** Wait for the cache's public durable-domain notification before refreshing the list. */
export async function warmNativeCache(ctx, header, events, signal) {
  if (!ctx.sessionProjectionCache) return;
  signal?.throwIfAborted();
  let release, timer, abort;
  const committed = new Promise((resolve, reject) => {
    release = ctx.on('domain/changed', change => {
      if (change.domain === 'session_projcache' && change.table === 'sessions' && change.key === header.id && change.operation === 'put') resolve();
    });
    timer = setTimeout(() => reject(new Error('Harness 标题缓存写入超时，请刷新目录重试')), 5000);
    abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    ctx.sessionProjectionCache.coldSnapshot(header, 0, events);
    await committed;
  } finally {
    release?.(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
    // Contain a pending notification rejection if the synchronous fold failed.
    void committed.catch(() => {});
  }
}

/** Uses Harness's authenticated Fetch carrier, matching its native export routes. */
export function installCatalogRoute(ctx, catalog, signal) {
  return ctx.connection.fetch.register({
    path: '/api/codex-import/catalog', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const force = new URL(request.url).searchParams.get('refresh') === '1';
      void catalog.ensure(signal, force).catch(error => ctx.logger?.warn(`Codex 导入目录读取失败：${error.message}`));
      return Response.json(catalog.snapshot(), { headers: { 'cache-control': 'no-store' } });
    },
  });
}
