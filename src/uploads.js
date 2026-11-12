import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, realpath, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { ExportArchive } from './archive.js';

export const MAX_ARCHIVE_BYTES = 1024 ** 3;
const TTL = 30 * 60 * 1000;
const idPattern = /^[a-f0-9-]{36}$/;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** Session-bound, bounded temporary ZIPs; filenames never determine host paths. */
export class ArchiveUploads {
  constructor(root, maxBytes = MAX_ARCHIVE_BYTES) {
    this.root = resolve(root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cache', 'codex-import', 'uploads'));
    this.maxBytes = maxBytes; this.entries = new Map(); this.pending = new Set(); this.active = 0;
    this.lifetime = new AbortController();
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 60000); this.timer.unref();
  }
  stage(owner, name, body, signal, declaredSize) {
    const task = this.stageFile(owner, name, body, signal, declaredSize);
    this.pending.add(task); task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  async stageFile(owner, name, body, signal, declaredSize) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    if (!owner || typeof owner !== 'string' || owner.length > 256) throw failure('缺少有效的导入会话');
    if (typeof name !== 'string' || name.length > 512 || !/\.zip$/i.test(name)) throw failure('请选择 ChatGPT 导出的 ZIP 文件');
    if (!body) throw failure('ZIP 文件为空');
    if (declaredSize != null && (!Number.isFinite(declaredSize) || declaredSize < 1 || declaredSize > this.maxBytes)) throw failure('ZIP 超过上传大小限制', 413);
    if (this.disposed) throw failure('导入服务已关闭', 503);
    if (this.active || this.entries.size >= 3) throw failure('已有文件正在准备或暂存文件过多，请先完成或取消当前导入', 409);
    this.active++;
    let directory, handle;
    try {
      signal?.throwIfAborted();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!this.cleaned) {
        this.cleaned = true;
        for (const entry of await readdir(this.root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^upload-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
          const path = join(this.root, entry.name);
          if ((await stat(path)).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
        }
      }
      directory = await mkdtemp(join(this.root, 'upload-'));
      const path = join(directory, 'archive.zip');
      handle = await open(path, 'wx', 0o600);
      let size = 0;
      const input = typeof body.getReader === 'function' ? Readable.fromWeb(body, { signal }) : Readable.from(body, { signal });
      for await (const chunk of input) {
        signal?.throwIfAborted(); size += chunk.byteLength;
        if (size > this.maxBytes) throw failure('ZIP 超过上传大小限制', 413);
        await handle.writeFile(chunk);
      }
      await handle.close(); handle = undefined;
      if (!size || (declaredSize != null && size !== declaredSize)) throw failure('ZIP 文件传输不完整，请重新选择');
      const archive = await new ExportArchive(path).open(signal);
      try {
        if (!archive.names().some(n => /^conversations(?:-\d+)?\.json$/.test(n))) throw failure('这个 ZIP 中没有 ChatGPT 对话，请选择 ChatGPT 导出的原始 ZIP');
      } finally { archive.close(); }
      signal?.throwIfAborted();
      if (this.disposed) throw failure('导入服务已关闭', 503);
      const entry = { id: randomUUID(), owner, name: basename(name), path, directory, size, expiresAt: Date.now() + TTL, leases: 0 };
      this.entries.set(entry.id, entry);
      return { id: entry.id, name: entry.name, size, expiresAt: entry.expiresAt };
    } catch (error) {
      await handle?.close(); if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally { this.active--; }
  }
  get(id, owner) {
    const entry = typeof id === 'string' && idPattern.test(id) ? this.entries.get(id) : undefined;
    if (!entry || entry.owner !== owner || entry.remove || entry.expiresAt < Date.now()) throw failure('ZIP 暂存已失效，请重新选择文件', 410);
    return entry;
  }
  acquire(id, owner) {
    const entry = this.get(id, owner); entry.leases++; entry.expiresAt = Date.now() + TTL;
    let released = false;
    return { path: entry.path, name: entry.name, release: async (remove = false) => {
      if (released) return; released = true; entry.leases--; entry.remove ||= remove; entry.expiresAt = Date.now() + TTL;
      if (entry.remove && !entry.leases) await this.deleteEntry(entry);
    } };
  }
  async deleteEntry(entry) { this.entries.delete(entry.id); await rm(entry.directory, { recursive: true, force: true }); }
  async remove(id, owner) {
    const entry = this.get(id, owner); entry.remove = true;
    if (!entry.leases) await this.deleteEntry(entry);
  }
  async sweep() {
    for (const entry of this.entries.values()) {
      if (entry.leases) { const now = new Date(); await utimes(entry.directory, now, now); }
      else if (entry.remove || entry.expiresAt < Date.now()) await this.deleteEntry(entry);
    }
  }
  async dispose() {
    this.disposed = true; this.lifetime.abort(new Error('导入服务已关闭')); clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.entries.values()].map(entry => this.deleteEntry(entry)));
  }
}

/** Discovery reads directory names only, not transcripts or credentials. */
export async function importSetup(config = {}, maxBytes = MAX_ARCHIVE_BYTES) {
  const configured = resolve(config.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
  const candidates = [configured, join(homedir(), '.codex')];
  if (process.platform === 'darwin') candidates.push(join(homedir(), 'Library', 'Application Support', 'Berth', 'Codex'));
  const sources = [], seen = new Set();
  for (const path of candidates) {
    try {
      const physical = await realpath(path);
      if (seen.has(physical) || !(await stat(physical)).isDirectory()) continue;
      seen.add(physical);
      const names = await readdir(physical);
      if (!names.some(n => /^(?:state|thread_history)_\d+\.sqlite$/.test(n) || ['sessions', 'archived_sessions'].includes(n))) continue;
      sources.push({ path: physical, label: path === configured ? '当前配置的 Codex' : path.includes('/Berth/') ? 'Berth Codex' : '默认 Codex' });
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return { source: config.source || 'codex', codexSources: sources, codexHome: sources[0]?.path || configured, maxArchiveBytes: maxBytes,
    defaults: { includeArchived: config.includeArchived !== false, importAttachments: config.importAttachments !== false,
      checkOverlap: config.checkOverlap !== false, importWorkspacePath: config.importWorkspacePath || '' } };
}

export function installUploadRoutes(ctx, uploads, config, lifetime) {
  const releases = [], pending = new Set();
  const scope = new AbortController();
  const register = (path, methods, requestBody, handle) => releases.push(ctx.connection.fetch.register({ path, methods, requestBody,
    fetch(request) {
      const signal = AbortSignal.any([request.signal, lifetime, scope.signal]);
      const task = (async () => {
        try { return Response.json(await handle(request, signal), { headers: { 'cache-control': 'no-store' } }); }
        catch (error) { return Response.json({ error: signal.aborted ? '已取消文件准备' : error.message }, { status: error.status || 400, headers: { 'cache-control': 'no-store' } }); }
      })();
      pending.add(task); task.finally(() => pending.delete(task)); return task;
    } }));
  register('/api/codex-import/setup', ['GET'], 'buffered', () => importSetup(config, uploads.maxBytes));
  register('/api/codex-import/upload', ['POST', 'DELETE'], 'streaming', async (request, signal) => {
    const params = new URL(request.url).searchParams;
    if (request.method === 'DELETE') { await uploads.remove(params.get('id'), params.get('sessionId')); return { ok: true }; }
    const length = request.headers.get('content-length');
    return uploads.stage(params.get('sessionId'), params.get('name'), request.body, signal, length == null ? undefined : Number(length));
  });
  return async () => { scope.abort(new Error('导入文件接口已关闭')); for (const release of releases) release(); await Promise.allSettled([...pending]); };
}
