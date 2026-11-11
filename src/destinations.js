import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

async function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return { reason: '未记录有效的绝对项目目录' };
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { reason: '原路径不是目录' };
    return { path: resolve(path), realPath: await realpath(path), dev: String(info.dev), ino: String(info.ino) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { reason: '原目录不存在' };
    if (['EACCES', 'EPERM'].includes(error.code)) return { reason: '原目录无法访问' };
    throw error;
  }
}
export async function verifyDestination(entry) {
  const current = await directory(entry.path);
  if (current.reason || (entry.identity && (current.realPath !== entry.identity.realPath || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino))) {
    throw new Error(`预览中的工作目录已变化：${entry.path}，请重新执行 /codex-import preview 后确认。`);
  }
}

/** Work directories are metadata; originals are never created or moved by import. */
export async function planDestinations(threads, options, signal) {
  const fallback = resolve(options.importWorkspacePath || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'imports', options.source === 'chatgpt' ? 'chatgpt' : 'codex'));
  const groupByProject = options.source !== 'chatgpt' && options.groupByProject !== false;
  const entries = Object.create(null); const cache = new Map();
  const summary = { mode: groupByProject ? 'original' : 'unified', originalSessions: 0, fallbackSessions: 0,
    originalProjects: 0, fallbackPath: fallback, examples: [] };
  const projects = new Set(); const examples = new Map();
  for (const thread of threads) {
    signal?.throwIfAborted();
    let entry;
    if (options.reviewedDestinations) {
      entry = options.reviewedDestinations[thread.id];
      if (!entry || entry.originalCwd !== (thread.cwd || '')) throw new Error('预览后的会话项目目录已变化，请重新预览后确认。');
      if (entry.kind === 'original') {
        const key = JSON.stringify([entry.path, entry.identity]);
        if (!cache.has(key)) { await verifyDestination(entry); cache.set(key, true); }
      } else if (entry.path !== fallback) throw new Error('预览中的回退目录已变化，请重新预览。');
    } else {
      let original;
      if (groupByProject) {
        if (!cache.has(thread.cwd)) cache.set(thread.cwd, await directory(thread.cwd));
        original = cache.get(thread.cwd);
      }
      entry = original && !original.reason
        ? { path: original.path, originalCwd: thread.cwd || '', kind: 'original', identity: original }
        : { path: fallback, originalCwd: thread.cwd || '', kind: 'fallback', reason: original?.reason || '统一导入目录' };
    }
    entries[thread.id] = entry;
    summary[entry.kind === 'original' ? 'originalSessions' : 'fallbackSessions']++;
    if (entry.kind === 'original') projects.add(entry.path);
    const key = `${entry.kind}:${entry.path}`;
    if (examples.has(key)) examples.get(key).count++;
    else examples.set(key, { path: entry.path, kind: entry.kind, count: 1 });
  }
  summary.originalProjects = projects.size;
  summary.examples = [...examples.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  return { entries, summary, fallback, groupByProject };
}
