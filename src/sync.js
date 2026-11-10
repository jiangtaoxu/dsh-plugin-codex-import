import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { digest } from './source.js';
import { convertSnapshot, projectedRecords } from './convert.js';
import { isImportedIdentity, IMPORT_ID } from './identity.js';

const projectionHash = projected => projected ? digest({ role: projected.role, content: projected.content }) : null;
const rawRows = snapshot => [
  ...snapshot.records.map(record => ({ storage: 'sqlite', ...record })),
  ...snapshot.supplemental.map(record => ({ storage: 'jsonl', ...record })),
];
const rowKey = row => `${row.storage}:${row.key}`;
export function snapshotManifest(snapshot) {
  const projected = new Map(projectedRecords(snapshot).map(({ record, projected }) => [record.key, snapshot.mediaMessages?.get(record.key) || projected]));
  return rawRows(snapshot).map(row => ({ key: rowKey(row), hash: digest(row.item), display: projectionHash(projected.get(row.key)) }));
}

export function importedState(header, events) {
  const source = events[0]?.type === 'codex-import/source' && events[0].data;
  const recovery = events.findLast(e => e.type === 'codex-import/recovery')?.data.sourceSessionId;
  if (!source || !isImportedIdentity(header.id, source, recovery)) return undefined;
  const initialEnd = events.findIndex(e => e.type === 'codex-import/complete');
  if (initialEnd < 0) return undefined;
  const marker = events.findLast(e => e.type === 'codex-import/sync');
  let manifest;
  if (marker) manifest = marker.data.manifest;
  else {
    const messages = new Map(events.flatMap(e => e.type === 'user/message' ? [[e.data.id, e.data]] : e.type === 'assistant/message' ? [[e.data.message.id, e.data.message]] : []));
    const original = events.slice(0, initialEnd).filter(e => e.type === 'codex-import/raw').map(e => e.data);
    manifest = original.map(row => ({ key: rowKey(row), hash: digest(row.item),
      display: projectionHash(messages.get(`codex-message-${digest([header.id, row.key]).slice(0, 32)}`)) }));
  }
  if (!Array.isArray(manifest) || manifest.some(row => typeof row.key !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash))) throw new Error('增量同步状态无效，已保留现有会话');
  const sourceMetadata = marker?.data.metadata || source.metadata;
  let continued = false, sync = false;
  for (const e of events.slice(initialEnd + 1)) {
    if (e.type === 'codex-import/sync-begin') sync = true;
    else if (e.type === 'codex-import/sync') sync = false;
    else if (!sync && ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'agent/inbox/spliced'].includes(e.type)) continued = true;
  }
  return { source, manifest, metadata: sourceMetadata, mode: marker?.data.mode || source.mode,
    fingerprint: marker?.data.fingerprint || source.fingerprint,
    sourceFingerprint: marker?.data.sourceFingerprint || source.sourceFingerprint || source.fingerprint,
    syncAt: marker?.time || 0, continued,
    title: events.findLast(e => e.type === 'session/title')?.data.title,
    pending: events.findLast(e => e.type === 'codex-import/sync-begin' && (!marker || e.seq > marker.seq)) };
}

/** Resolve only already-proved copies in the same source/thread/destination namespace. */
export class SyncIndex {
  constructor(services, home, headers, targets) { this.services = services; this.home = home; this.headers = headers; this.targets = targets; }
  static async create(services, home, signal, targets) {
    const headers = services.sessionPersistence ? await services.sessionPersistence.list({ signal }) : [];
    return new SyncIndex(services, home, headers.filter(row => IMPORT_ID.test(row.header.id)), targets);
  }
  async select(snapshot, signal) {
    const prefix = `codex-${digest([this.home, snapshot.thread.id, snapshot.destinationCwd ?? snapshot.thread.cwd ?? null]).slice(0, 24)}-`;
    const expected = this.targets?.[snapshot.thread.id];
    const choices = this.headers.filter(row => row.header.id.startsWith(prefix) || row.header.id.startsWith('codex-recovered-'));
    let best, broken;
    if (typeof expected === 'string' && !choices.some(row => row.header.id === expected)) throw new Error('预览中的同步副本已不存在，请重新预览');
    for (const row of choices) {
      if (typeof expected === 'string' && row.header.id !== expected) continue;
      signal?.throwIfAborted(); let reader;
      try {
        reader = await this.services.sessionPersistence.open(row.header.id, 'read', { signal });
        const events = (await reader.read()).events;
        const state = importedState(row.header, events);
        if (!state && row.header.id.startsWith(prefix) && row.header.id !== prefix + snapshot.fingerprint.slice(0, 24)) broken = new Error('已有副本尚未完成导入，已保留，请先恢复原导入');
        if (!state || state.source.codexHome !== this.home || state.source.threadId !== snapshot.thread.id
          || (state.source.destinationCwd ?? state.source.metadata.cwd) !== snapshot.destinationCwd) continue;
        const score = [state.syncAt ? 1 : 0, state.continued ? 1 : 0, state.fingerprint === snapshot.fingerprint ? 1 : 0,
          state.source.attachmentFormat || 0, state.syncAt || events.reduce((time, e) => e.type === 'user/message' ? Math.max(time, e.time) : time, 0), state.manifest.length];
        if (!best || score.some((value, i) => value !== best.score[i] && score.slice(0, i).every((v, j) => v === best.score[j]) && value > best.score[i])) best = { header: row.header, state, score };
      } catch (error) { if (signal?.aborted) throw error; if (row.header.id.startsWith(prefix)) broken = error; }
      finally { await reader?.close(); }
    }
    if (!best && broken && !(String(broken.message).includes('system/message requires a protected first surface head') && this.headers.some(row => row.header.id === prefix + snapshot.fingerprint.slice(0, 24)))) throw broken;
    if (expected === null && best) throw new Error('预览后已有新导入副本，请重新预览以避免重复');
    return best;
  }
}

export function syncDifference(state, snapshot, preview = false) {
  const manifest = snapshotManifest(snapshot); const before = new Map(state.manifest.map(row => [row.key, row]));
  const currentKeys = new Set(manifest.map(row => row.key));
  const deleted = state.manifest.filter(row => !currentKeys.has(row.key)).length;
  const changed = new Set(); let added = 0, revised = 0;
  const equivalences = new Map();
  if (state.mode !== snapshot.mode && state.mode !== 'metadata-only') for (const row of state.manifest) {
    if (row.display) equivalences.set(row.display, (equivalences.get(row.display) || 0) + 1);
  }
  for (const row of manifest) {
    const old = before.get(row.key);
    if (!old && row.display && equivalences.get(row.display) > 0) { equivalences.set(row.display, equivalences.get(row.display) - 1); continue; }
    if (!old || old.hash !== row.hash || (!preview && row.display !== old.display)) {
      changed.add(row.key);
      if (row.display) { if (old) revised++; else added++; }
    }
  }
  return { manifest, changed, added, revised, deleted, metadataChanged: state.metadata?.title !== snapshot.thread.title,
    sourceChanged: state.sourceFingerprint !== (snapshot.sourceFingerprint || snapshot.fingerprint) };
}

/** Build an append-only, replayable transaction; existing native messages never move. */
export function buildSyncTransaction(header, events, snapshot, version) {
  const state = importedState(header, events);
  if (!state) throw new Error('无法验证导入来源，拒绝同步');
  const diff = syncDifference(state, snapshot);
  if (state.fingerprint === snapshot.fingerprint && !diff.changed.size && !diff.deleted && !diff.metadataChanged) return undefined;
  let openTurn = false;
  for (const e of events) { if (e.type === 'turn/start') openTurn = true; else if (e.type === 'turn/end') openTurn = false; }
  if (openTurn) throw new Error('目标会话有未结束的轮次，已保留，结束或恢复该轮次后重试同步');
  const selected = projectedRecords(snapshot).filter(({ record }) => diff.changed.has(`${snapshot.mode === 'sqlite' ? 'sqlite' : 'jsonl'}:${record.key}`));
  const entries = selected.map(({ record, projected }) => ({ record: { ...record, key: `sync:${events.length}:${record.key}:${digest(record.item).slice(0, 20)}` }, projected: snapshot.mediaMessages?.get(record.key) || projected }));
  const now = Date.now();
  if (diff.added || diff.revised || diff.deleted) entries.unshift({ record: { key: `sync-notice:${events.length}:${snapshot.fingerprint}`, time: now }, projected: { role: 'assistant', content: [{ type: 'text', text:
    `【Codex 增量同步】新增 ${diff.added} 条消息，修订 ${diff.revised} 条；源端减少 ${diff.deleted} 条记录。以下为此次新增/修订的内容，按同步时间追加；原有历史和 Harness 续聊均保留。修订消息作为新版本追加，源端删除不会删除 Harness 中的历史。` }] } });
  const converted = convertSnapshot('', { ...snapshot, records: [], supplemental: [], targetSessionId: header.id, projectedEntries: entries, suppressHead: true, skipLocationNotice: true }, version);
  const offsetTurn = events.reduce((turn, e) => Math.max(turn, Number(e.data?.turn) || 0), 0);
  const body = [];
  const add = (type, data, extra = {}) => body.push({ seq: events.length + 1 + body.length, type, time: now, data, ...extra });
  const sourceTitle = state.metadata?.title?.trim() || `Codex ${state.source.threadId}`;
  if (diff.metadataChanged && (!state.title || state.title === sourceTitle)) add('session/title', {
    title: snapshot.thread.title?.trim() || `Codex ${snapshot.thread.id}`, messageSeqs: [], source: { kind: 'user' } });
  for (const row of rawRows(snapshot)) if (diff.changed.has(rowKey(row))) add('codex-import/raw', row, { ignorable: true });
  for (const e of converted.events) {
    if (['codex-import/source', 'codex-import/raw', 'codex-import/complete', 'session/title'].includes(e.type)) continue;
    if (e.type === 'system/message') continue;
    const next = structuredClone(e); next.seq = events.length + 1 + body.length;
    if (typeof next.data?.turn === 'number') next.data.turn += offsetTurn;
    body.push(next);
  }
  add('codex-import/sync', { format: 1, fingerprint: snapshot.fingerprint, sourceFingerprint: snapshot.sourceFingerprint || snapshot.fingerprint,
    metadata: snapshot.thread, mode: snapshot.mode, manifest: diff.manifest,
    added: diff.added, revised: diff.revised, deleted: diff.deleted, attachments: snapshot.attachmentSummary || null }, { ignorable: true });
  const transaction = digest(body);
  return { begin: { seq: events.length, type: 'codex-import/sync-begin', time: now, ignorable: true,
    data: { format: 1, transaction, events: body } }, body, diff };
}

async function finishTransaction(writer, events, begin, onBatch, header) {
  const plan = begin.data.events;
  if (!Array.isArray(plan) || digest(plan) !== begin.data.transaction || plan.at(-1)?.type !== 'codex-import/sync') throw new Error('同步恢复计划校验失败，未改写任何历史');
  const allowed = new Set(['session/title', 'codex-import/raw', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'codex-import/files', 'step/end', 'turn/end', 'codex-import/sync']);
  if (plan.some((event, i) => !allowed.has(event.type) || event.seq !== begin.seq + i + 1)) throw new Error('同步恢复计划事件范围无效');
  validateStoredEvents(header, [...events.slice(0, begin.seq + 1), ...plan]);
  const existing = events.slice(begin.seq + 1);
  for (let i = 0; i < existing.length; i++) if (JSON.stringify(existing[i]) !== JSON.stringify(plan[i])) throw new Error('未完成同步后目标又有变化，已保留所有内容，需先处理同步冲突');
  // Once begun, finish the current transaction even when the user cancels; cancellation stops before the next chat.
  for (let offset = existing.length; offset < plan.length; offset += 128) {
    await writer.append(plan.slice(offset, offset + 128)); onBatch?.(Math.min(offset + 128, plan.length), plan.length);
  }
  await writer.flush();
  return [...events.slice(0, begin.seq + 1), ...plan];
}

export async function synchronizeCopy(services, target, snapshot, signal, onBatch) {
  const id = target.header.id;
  const difference = syncDifference(target.state, snapshot);
  if (!target.state.pending && target.state.fingerprint === snapshot.fingerprint && !difference.changed.size && !difference.deleted && !difference.metadataChanged) return { status: 'skipped', id };
  if (services.agents?.get?.(id) || services.sessions?.get?.(id)) return { status: 'deferred', id, reason: '会话正在 Harness 中打开或运行，关闭该会话后重试；不会生成新副本' };
  signal?.throwIfAborted(); let writer;
  try { writer = await services.sessionPersistence.open(id, 'write', { signal }); }
  catch (error) {
    if (/lock|busy|占用/i.test(error.message)) return { status: 'deferred', id, reason: '目标会话被占用，稍后重试；不会生成新副本' };
    throw error;
  }
  try {
    let events = (await writer.read()).events;
    const state = importedState(target.header, events);
    if (!state) throw new Error('目标身份已变化，拒绝同步');
    if (state.pending) events = await finishTransaction(writer, events, state.pending, onBatch, target.header);
    const transaction = buildSyncTransaction(target.header, events, snapshot, services.formatVersion);
    if (!transaction) return { status: state.pending ? 'updated' : 'skipped', id, header: target.header, events };
    signal?.throwIfAborted(); validateStoredEvents(target.header, [...events, transaction.begin, ...transaction.body]); await writer.append([transaction.begin]);
    events = await finishTransaction(writer, [...events, transaction.begin], transaction.begin, onBatch, target.header);
    return { status: 'updated', id, header: target.header, events, added: transaction.diff.added, revised: transaction.diff.revised };
  } finally { await writer.close(); }
}
