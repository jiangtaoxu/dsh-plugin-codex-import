import { createReadStream } from 'node:fs';
import { jsonlLines } from './jsonl.js';
import { lstat, realpath, readdir, open, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { digest } from './source.js';
import { readZstdFrames } from './zstd.js';

const NORMAL = /^codex-[a-f0-9]{24}-[a-f0-9]{24}$/;
const RECOVERED = /^codex-recovered-[a-f0-9]{24}$/;
const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;
const within = (path, root) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); };

/** Classify only plugin-created identities; manual forks and native chats stay out. */
export async function inspectImportedFile(path, expectedId, signal) {
  const decoded = path.endsWith('.zstd') ? readZstdFrames(path, signal) : createReadStream(path);
  let header, source, complete = false, continued = false, syncing = false, recoverySource;
  try {
    for await (const line of jsonlLines(decoded)) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      if (!header) {
        header = JSON.parse(line);
        if (header.type !== 'session' || header.id !== expectedId) return undefined;
        continue;
      }
      if (!source) {
        const event = JSON.parse(line);
        if (event.type !== 'codex-import/source' || event.seq !== 0 || event.data?.format !== 1) return undefined;
        source = event.data;
        if (typeof source.codexHome !== 'string' || !isAbsolute(source.codexHome)
          || typeof source.threadId !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint || '')) return undefined;
        continue;
      }
      // Our JSONL writer puts the envelope type before the large raw payload.
      const type = /"type"\s*:\s*"([^"\\]+)"/.exec(line.slice(0, 256))?.[1] || JSON.parse(line).type;
      if (type === 'codex-import/complete') complete = true;
      else if (type === 'codex-import/sync-begin') syncing = true;
      else if (type === 'codex-import/sync') syncing = false;
      else if (complete && !syncing && ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(type)) continued = true;
      else if (complete && !syncing && type === 'agent/inbox/spliced' && JSON.parse(line).data?.inserted?.length) continued = true;
      else if (type === 'codex-import/recovery') recoverySource = JSON.parse(line).data?.sourceSessionId;
    }
  } finally { decoded.destroy?.(); await decoded.return?.(); }
  if (!source) return undefined;
  const expected = `codex-${digest([source.codexHome, source.threadId, source.destinationCwd ?? source.metadata?.cwd ?? null]).slice(0, 24)}-${source.fingerprint.slice(0, 24)}`;
  if (expectedId !== expected && !(RECOVERED.test(expectedId) && recoverySource === expected)) return undefined;
  return { id: expectedId, sourceHome: resolve(source.codexHome), continued, incomplete: !complete,
    title: source.metadata?.name || source.metadata?.title || source.threadId };
}

async function safeFiles(snapshot, root) {
  if (snapshot.location?.kind !== 'jsonl' || !snapshot.location.path) throw new Error('仅支持 Harness JSONL 会话存储');
  if ((await lstat(snapshot.location.path)).isSymbolicLink()
    || (await lstat(dirname(resolve(snapshot.location.path)))).isSymbolicLink()) throw new Error('拒绝清理符号链接会话');
  const path = await realpath(snapshot.location.path);
  const directory = dirname(path);
  if (basename(directory) !== snapshot.header.id || !within(directory, root)) throw new Error('会话路径不在专用 Harness 存储目录内');
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('拒绝清理符号链接会话目录');
  const files = [];
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || (!GENERATION.test(entry.name) && entry.name !== 'session.lock')) throw new Error('会话目录中有其他文件，已保留');
    if (GENERATION.test(entry.name)) {
      const file = join(directory, entry.name);
      if (await realpath(file) !== file) throw new Error('拒绝清理符号链接文件');
      files.push(file); bytes += (await stat(file)).size;
    }
  }
  return { directory, files, bytes };
}

function baseReport(total = 0) {
  return { mode: 'delete-plan', total, processed: 0, imported: 0, skipped: 0, recovered: 0,
    metadataOnly: 0, failed: [], deleted: 0, found: 0, preserved: 0, warnings: [] };
}

async function assertOutsideSource(directory, root, sourceHome) {
  // Also protect sources addressed through a symlink (e.g. CODEX_HOME aliases).
  const physicalSource = await realpath(sourceHome).catch(error => {
    if (error.code === 'ENOENT') return sourceHome;
    throw error;
  });
  for (const source of [sourceHome, physicalSource]) {
    if (directory === source || within(directory, source) || root === source || within(root, source)) {
      throw new Error('拒绝操作 Codex 源数据目录');
    }
  }
}

/** One-use, session-bound confirmation plans; no filesystem deletion during scanning. */
export class CleanupPlans {
  constructor(root) { this.root = resolve(root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')); this.plans = new Map(); }

  async scan(services, sessionId, signal, progress) {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('当前清理仅支持 macOS / Linux 的 JSONL 存储');
    const root = await realpath(this.root);
    const snapshots = (await services.sessionPersistence.list({ signal }))
      .filter(row => NORMAL.test(row.header.id) || RECOVERED.test(row.header.id));
    const report = baseReport(snapshots.length);
    const entries = [];
    for (const snapshot of snapshots) {
      signal?.throwIfAborted();
      try {
        const safe = await safeFiles(snapshot, root);
        const classified = await inspectImportedFile(snapshot.location.path, snapshot.header.id, signal);
        if (classified) {
          await assertOutsideSource(safe.directory, root, classified.sourceHome);
          entries.push({ ...classified, ...safe, revision: snapshot.revision });
          report.found++;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        report.failed.push({ threadId: snapshot.header.id, error: error.message });
      }
      report.processed++;
      progress?.({ ...report, failed: report.failed.length, phase: 'cleanup-scanning', currentTitle: entries.at(-1)?.title || '' });
      await new Promise(resolve => setImmediate(resolve));
    }
    const token = randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    // Drop older plans: only a freshly displayed scope can be confirmed.
    this.plans.clear();
    this.plans.set(token, { sessionId, root, entries, expiresAt });
    const continuedCount = entries.filter(entry => entry.continued).length;
    report.proposal = { token, count: entries.length, continuedCount, plainCount: entries.length - continuedCount,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), expiresAt };
    report.text = `找到 ${entries.length} 条插件导入副本，其中 ${continuedCount} 条有 Harness 新增续聊。\n请在下方选择是否一并删除续聊，并输入确认文字。\n只清理 Harness 的会话记录；Codex 源目录、项目代码、手动创建的会话和文件不会删除。\n本次进程中已激活或被占用的副本会保留；可重启 Harness 后在新会话重试。`;
    if (report.failed.length) report.text += `\n另有 ${report.failed.length} 条无法安全确认范围，清理时会保留。`;
    return report;
  }

  confirm(token, sessionId, includeContinued, confirmation) {
    const plan = this.plans.get(token);
    if (!plan || plan.sessionId !== sessionId || Date.now() > plan.expiresAt) throw new Error('删除预览已失效，请重新执行 /codex-import delete');
    if (typeof includeContinued !== 'boolean') throw new Error('必须明确选择是否删除续聊');
    const entries = plan.entries.filter(entry => includeContinued || !entry.continued);
    if (!entries.length) throw new Error('当前选择没有可删除的会话');
    if (confirmation !== `删除 ${entries.length} 条会话`) throw new Error('确认文字不匹配，尚未删除任何内容');
    this.plans.delete(token);
    return { ...plan, entries, includeContinued, preserved: plan.entries.length - entries.length };
  }
}

/** Delete only audited JSONL generations under exclusive session locks. */
export async function deleteImported(services, plan, signal, progress) {
  const report = { ...baseReport(plan.entries.length), mode: 'delete', preserved: plan.preserved };
  // Verify the entire reviewed scope before stopping agents or unlinking anything.
  for (const entry of plan.entries) {
    signal?.throwIfAborted();
    const snapshot = await services.sessionPersistence.stat(entry.id, { signal });
    if (!snapshot || snapshot.revision !== entry.revision) throw new Error('预览后会话内容发生变化，请重新预览并确认删除');
    await safeFiles(snapshot, plan.root);
  }
  for (const entry of plan.entries) {
    signal?.throwIfAborted();
    let lock;
    let archived = false, removed = false;
    const wasArchived = services.workspaceRegistry.archivedSessionIds?.includes(entry.id);
    const wasPinned = services.workspaceRegistry.pinnedSessionIds?.includes(entry.id);
    try {
      // The registry exposes bare Agents, not their owner's disposal capability.
      if (services.agents?.get(entry.id)) throw new Error('会话已在本次进程激活，已保留；请重启 Harness 后在新会话重试');
      await services.workspaceRegistry.archiveSession(entry.id, { stopActivity: true });
      archived = true;
      lock = await open(join(entry.directory, 'session.lock'), 'a');
      await tryLockExclusive(lock.fd);
      const held = await lock.stat({ bigint: true });
      const current = await stat(join(entry.directory, 'session.lock'), { bigint: true });
      if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('会话锁发生变化，已保留内容');
      const snapshot = await services.sessionPersistence.stat(entry.id, { signal });
      if (!snapshot) throw new Error('会话已不存在');
      const safe = await safeFiles(snapshot, plan.root);
      const classified = await inspectImportedFile(snapshot.location.path, entry.id, signal);
      if (!classified || classified.sourceHome !== entry.sourceHome) throw new Error('会话来源发生变化，已保留内容');
      if (!plan.includeContinued && classified.continued) {
        report.preserved++;
        throw new Error('会话新增了续聊，已按保留续聊的选择保留');
      }
      if (snapshot.revision !== entry.revision) throw new Error('预览后会话内容发生变化，已保留；请重新预览并确认');
      await assertOutsideSource(safe.directory, plan.root, entry.sourceHome);
      // A complete per-session unit is removed even if cancellation arrives mid-unit.
      // Keep the empty lock file and directory to preserve the lock inode for other writers.
      for (const file of safe.files) await unlink(file);
      removed = true;
      report.deleted++;
      for (const workspace of services.workspaceRegistry.list()) {
        if (workspace.sessionIds.includes(entry.id)) await workspace.detachSession(entry.id);
      }
      await services.workspaceRegistry.unpinSession(entry.id);
      await services.workspaceRegistry.unarchiveSession(entry.id);
    } catch (error) {
      if (signal?.aborted) throw error;
      report.failed.push({ threadId: entry.id, error: error.message });
    } finally {
      await lock?.close();
      if (archived && !removed && !wasArchived) {
        await services.workspaceRegistry.unarchiveSession(entry.id);
        if (wasPinned) await services.workspaceRegistry.pinSession(entry.id);
      }
    }
    report.processed++;
    progress?.({ ...report, failed: report.failed.length, phase: 'deleting', currentTitle: entry.title });
    await new Promise(resolve => setImmediate(resolve));
  }
  report.text = `清理完成：已删除 ${report.deleted} 条 Harness 导入副本，保留有续聊的副本 ${report.preserved} 条，失败 ${report.failed.length} 条。\nCodex 原位置的数据未修改。`;
  if (report.failed.length) report.text += '\n' + report.failed.slice(0, 10).map(row => `${row.threadId}: ${row.error}`).join('\n');
  return report;
}
