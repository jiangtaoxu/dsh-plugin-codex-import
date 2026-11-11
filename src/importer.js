import { stat, mkdir } from 'node:fs/promises';
import { CodexSource } from './source.js';
import { ChatGPTSource } from './chatgpt-source.js';
import { convertSnapshot } from './convert.js';
import { recoverImportedSession } from './recovery.js';
import { prepareAttachments } from './media.js';
import { planDestinations, verifyDestination } from './destinations.js';
import { SyncIndex, syncDifference, synchronizeCopy } from './sync.js';
import { AttachmentAudit } from './attachment-audit.js';
import { harnessOverlapIndex, snapshotMessages } from './overlap.js';

/** Summarize each thread without exposing conversation content to command output. */
export function reportText(report) {
  const lines = [
    report.dryRun ? `${report.sourceKind === 'chatgpt' ? 'ChatGPT' : 'Codex'} 导入预览（未写入）` : `${report.sourceKind === 'chatgpt' ? 'ChatGPT' : 'Codex'} 导入完成`,
    `会话: ${report.total}；有正文: ${report.withBody}；仅索引: ${report.metadataOnly}`,
    report.dryRun ? `已检查: ${report.processed}；失败: ${report.failed.length}；尚未复制，确认后导入` : `新建: ${report.imported}；增量更新: ${report.updated || 0}；待重试: ${report.deferred || 0}；已存在: ${report.skipped}；断点续传: ${report.recovered}；失败: ${report.failed.length}`,
    report.sourceKind === 'chatgpt' ? `ChatGPT 原始节点: ${report.items}；当前路径消息: ${report.sourceSummary?.selectedMessages || 0}；其他分支消息: ${report.sourceSummary?.offPathMessages || 0}` : `SQLite 条目: ${report.items}；JSONL 原始记录: ${report.rolloutRecords}`,
    ...(report.dryRun ? [] : [`已关联项目: ${report.workspaces}；未关联项目的会话: ${report.ungrouped}`]),
  ];
  if (report.syncExisting) lines.push(`增量同步计划：新增 ${report.syncSummary.new}，源变化 ${report.syncSummary.changed}，源未变化 ${report.syncSummary.unchanged}；实际更新以确认时为准`);
  if (report.overlap) lines.push(`内容重合检查：已读 ${report.overlap.scanned} 条 dsh 会话；${report.overlap.exactConversations} 条导出对话的文本序列相同，${report.overlap.sharedConversations} 条存在相同长消息。跨来源仅提示，保留双方，不自动合并或跳过。`);
  if (report.destinationSummary) {
    const d = report.destinationSummary;
    lines.push(`工作目录：${d.mode === 'original' ? `优先原项目，${d.originalSessions} 条会话复用 ${d.originalProjects} 个现有目录` : '统一导入目录'}；${d.fallbackSessions} 条放入 ${d.fallbackPath}`);
    for (const row of d.examples) lines.push(`${row.kind === 'original' ? '原项目' : '导入目录'}：${row.path}（${row.count} 条）`);
  } else if (report.importWorkspacePath) lines.push(`统一分组：${report.workspaceTitle}（${report.importWorkspacePath}）`);
  if (report.attachmentFound) lines.push(`附件${report.dryRun ? '可导入' : '已复制'}：图片 ${report.attachmentImages}，文件 ${report.attachmentFiles}；缺失或不可导入 ${report.attachmentMissing}`);
  if (report.attachmentAudit) {
    const a = report.attachmentAudit;
    lines.push(`附件去重后：可恢复图片 ${a.available.images.unique}、文件 ${a.available.files.unique}；不可导入图片 ${a.missing.images.unique}、文件 ${a.missing.files.unique}（引用 ${a.missing.images.references + a.missing.files.references} 次）`);
    if (a.reference?.files.references) lines.push(`代码位置引用（不计入附件）：${a.reference.files.unique} 个来源 / ${a.reference.files.references} 次引用`);
    for (const reason of a.reasons) lines.push(`${reason.label}：图片 ${reason.images.unique} 项 / ${reason.images.references} 次，文件 ${reason.files.unique} 项 / ${reason.files.references} 次`);
  }
  for (const failure of report.failed) lines.push(`${failure.threadId}: ${failure.error}`);
  for (const warning of report.warnings) lines.push(`提示: ${warning}`);
  return lines.join('\n');
}

async function workspaceFor(registry, cwd, projectTitle) {
  if (!registry || !cwd) return undefined;
  try {
    if (!(await stat(cwd)).isDirectory()) return undefined;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
  return registry.create(cwd, projectTitle);
}

/** Write through Harness's persistence service, never by editing its files. */
async function persist(persistence, converted, signal, onBatch) {
  const { header, events } = converted;
  let handle;
  let existing = !!(await persistence.stat(header.id, { signal }));
  if (!existing) {
    try { handle = await persistence.create(header, { signal }); }
    catch (error) {
      if (error.name !== 'SessionAlreadyExistsError') throw error;
      existing = true;
    }
  }
  if (existing) {
    let reader;
    try { reader = await persistence.open(header.id, 'read', { signal }); }
    catch (error) {
      if (String(error.message).includes('system/message requires a protected first surface head')) {
        return recoverImportedSession(persistence, header.id, signal);
      }
      throw error;
    }
    try {
      // Legacy snapshots have one fewer event (no empty system head).
      const markers = (await reader.read(Math.max(0, events.length - 2), 2, { signal })).events;
      if (markers.some(marker => marker.type === 'codex-import/complete'
        && marker.data.fingerprint === events.at(-1).data.fingerprint)) return { status: 'skipped', id: header.id };
    } finally { await reader.close(); }
    handle = await persistence.open(header.id, 'write', { signal });
  }
  try {
    let offset = 0;
    if (existing) {
      const previous = (await handle.read()).events;
      // A crash may have committed a prefix. Resume only an exact matching prefix.
      for (let i = 0; i < previous.length; i++) {
        if (JSON.stringify(previous[i]) !== JSON.stringify(events[i])) {
          throw new Error('Incomplete target differs from source snapshot; refusing to overwrite it');
        }
      }
      offset = previous.length;
    }
    // One thread at a time; bounded batches also make cancellation responsive.
    for (; offset < events.length; offset += 128) {
      signal?.throwIfAborted();
      await handle.append(events.slice(offset, offset + 128), { signal });
      onBatch?.(Math.min(offset + 128, events.length), events.length);
    }
    await handle.flush({ signal });
    return { status: existing ? 'recovered' : 'imported', id: header.id };
  } finally { await handle.close(); }
}

/** Import all recoverable local conversations, with explicit metadata-only results. */
export async function importCodex(services, options = {}, signal, onProgress) {
  onProgress?.({ phase: 'discovering', total: null, processed: 0, imported: 0, skipped: 0, recovered: 0, failed: 0, metadataOnly: 0 });
  if (options.source && !['codex', 'chatgpt'].includes(options.source)) throw new Error('source 必须为 codex 或 chatgpt');
  const chatgpt = options.source === 'chatgpt';
  const source = await (chatgpt ? new ChatGPTSource(options.archivePath, options.sourceId) : new CodexSource(options.codexHome)).open(signal);
  const report = { dryRun: options.dryRun !== false, total: 0, withBody: 0, metadataOnly: 0,
    imported: 0, updated: 0, deferred: 0, skipped: 0, recovered: 0, syncSummary: { new: 0, changed: 0, unchanged: 0 }, items: 0, rolloutRecords: 0, workspaces: 0,
    ungrouped: 0, failed: [], warnings: [], sourceHome: source.home, processed: 0,
    attachmentFound: 0, attachmentImages: 0, attachmentFiles: 0, attachmentMissing: 0,
    ...(chatgpt ? { sourceKind: 'chatgpt', sourcePath: source.path, archiveFingerprint: source.archive.fingerprint, sourceSummary: source.summary } : {}) };
  const audit = services.createAttachmentAudit?.() || new AttachmentAudit();
  const attachmentWarnings = new Set();
  const deferredWarnings = new Set();
  const workspaceIds = new Set();
  const publish = (phase, thread, extra = {}) => onProgress?.({ phase, total: report.total,
    processed: report.processed, imported: report.imported, skipped: report.skipped, recovered: report.recovered,
    updated: report.updated, deferred: report.deferred, syncSummary: report.syncSummary,
    failed: report.failed.length, metadataOnly: report.metadataOnly, withBody: report.withBody,
    attachmentImages: report.attachmentImages, attachmentFiles: report.attachmentFiles, attachmentMissing: report.attachmentMissing,
    attachmentAudit: audit.snapshot(), destinationSummary: report.destinationSummary,
    ...(chatgpt ? { sourceKind: 'chatgpt', sourceSummary: source.summary } : {}),
    currentTitle: String(thread?.name || thread?.title || thread?.first_user_message || thread?.id || '').replace(/\s+/g, ' ').slice(0, 160), ...extra });
  try {
    if (chatgpt && options.reviewedArchiveFingerprint && options.reviewedArchiveFingerprint !== source.archive.fingerprint) throw new Error('预览后的 ChatGPT 导出包发生变化，请重新预览后确认');
    const overlap = chatgpt && report.dryRun && options.checkOverlap !== false ? await harnessOverlapIndex(services, signal) : undefined;
    if (overlap) report.overlap = { scanned: overlap.index.rows.length, exactConversations: 0, sharedConversations: 0, matches: [], failed: overlap.warnings.length };
    const threads = source.list(options);
    report.total = threads.length;
    if (report.dryRun) report.previewThreadIds = threads.map(thread => thread.id);
    publish('ready');
    const destinations = await planDestinations(threads, options, signal);
    report.destinationSummary = destinations.summary;
    report.groupByProject = destinations.groupByProject;
    const syncIndex = options.syncExisting !== false ? await SyncIndex.create(services, source.home, signal, options.reviewedSyncTargets) : undefined;
    report.syncExisting = !!syncIndex;
    report.workspaceTitle = chatgpt && (!options.workspaceTitle || options.workspaceTitle === 'Codex 导入') ? 'ChatGPT 导入' : options.workspaceTitle || 'Codex 导入';
    report.importWorkspacePath = destinations.fallback;
    if (report.dryRun) { report.previewDestinations = destinations.entries; report.previewSyncTargets = {}; }
    if (!report.dryRun && destinations.summary.fallbackSessions) {
      signal?.throwIfAborted();
      await mkdir(destinations.fallback, { recursive: true });
    }
    publish('ready');
    for (const thread of threads) {
      signal?.throwIfAborted();
      publish('reading', thread);
      try {
        const snapshot = await source.read(thread, signal);
        if (overlap) {
          const match = overlap.index.compare(snapshotMessages(snapshot));
          if (match.exact.length) report.overlap.exactConversations++;
          if (match.shared.length) report.overlap.sharedConversations++;
          if ((match.exact.length || match.shared.length) && report.overlap.matches.length < 30) report.overlap.matches.push({ threadId: thread.id,
            exact: match.exact.slice(0, 10), shared: match.shared.slice(0, 10) });
        }
        if (chatgpt) await source.archive.assertUnchanged(signal);
        const destination = destinations.entries[thread.id];
        if (!report.dryRun) await verifyDestination(destination);
        snapshot.destinationCwd = destination.path;
        snapshot.destinationKind = destination.kind;
        if (options.importAttachments !== false && (report.dryRun || services.attachments)) {
          publish('attachments', thread);
          let lastMediaUpdate = 0;
          const media = await prepareAttachments(snapshot, services.attachments, { ...options, dryRun: report.dryRun }, signal, media => {
            if (Date.now() - lastMediaUpdate < 150) return;
            lastMediaUpdate = Date.now();
            publish('attachments', thread, { attachmentImages: report.attachmentImages + media.images,
              attachmentFiles: report.attachmentFiles + media.files, attachmentMissing: report.attachmentMissing + media.missing });
          }, (entry, sourceThread, key) => audit.add(entry, sourceThread, key));
          report.attachmentFound += media.found; report.attachmentImages += media.images;
          report.attachmentFiles += media.files; report.attachmentMissing += media.missing;
          for (const warning of snapshot.attachmentWarnings || []) attachmentWarnings.add(warning);
        }
        const target = syncIndex ? await syncIndex.select(snapshot, signal) : undefined;
        if (report.dryRun) report.previewSyncTargets[thread.id] = target?.header.id || null;
        if (!target) report.syncSummary.new++;
        else {
          const diff = syncDifference(target.state, snapshot, report.dryRun);
          report.syncSummary[diff.changed.size || diff.deleted || diff.metadataChanged || diff.sourceChanged || target.state.pending ? 'changed' : 'unchanged']++;
        }
        report[snapshot.mode === 'metadata-only' ? 'metadataOnly' : 'withBody']++;
        report.items += snapshot.records.length;
        report.rolloutRecords += snapshot.supplemental.length;
        if (!report.dryRun) {
          if (!services.sessionPersistence) throw new Error('Harness sessionPersistence service is required');
          await verifyDestination(destination);
          if (chatgpt) await source.archive.assertUnchanged(signal);
          publish('converting', thread);
          const converted = convertSnapshot(source.home, snapshot, services.formatVersion);
          publish('writing', thread);
          const result = target ? await synchronizeCopy(services, target, snapshot, signal,
            (writtenEvents, totalEvents) => publish('writing', thread, { writtenEvents, totalEvents }))
            : await persist(services.sessionPersistence, converted, signal,
            (writtenEvents, totalEvents) => publish('writing', thread, { writtenEvents, totalEvents }));
          report[result.status]++;
          if (result.status === 'deferred') deferredWarnings.add(`${thread.id}：${result.reason}`);
          else {
          // The native cold list reads projection checkpoints, not logged titles.
          // Only seed from the exact newly written log; resumed copies can have newer titles.
          if (['imported', 'updated'].includes(result.status)) {
            const written = result.status === 'updated' ? result : converted;
            if (services.warmCache) await services.warmCache(written.header, written.events, signal);
            else services.sessionProjectionCache?.coldSnapshot(written.header, 0, written.events);
          }
          publish('grouping', thread);
          // Retrying a completed import also repairs previously interrupted grouping.
          const workspace = await workspaceFor(services.workspaceRegistry, destination.path,
            destination.kind === 'fallback' ? report.workspaceTitle : thread.project?.title ?? thread.project?.name);
          if (workspace) {
            await workspace.attachSession(result.id);
            workspaceIds.add(workspace.id);
          } else report.ungrouped++;
          if (services.workspaceRegistry && options.preserveArchive !== false) {
            const id = result.id;
            if (thread.archived) await services.workspaceRegistry.archiveSession(id);
            else if (thread.is_pinned) await services.workspaceRegistry.pinSession(id);
          }
          if (result.repairedOriginal && services.workspaceRegistry) {
            await services.workspaceRegistry.archiveSession(result.repairedOriginal);
          }
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        report.failed.push({ threadId: thread.id, error: error.message ?? String(error) });
      }
      report.processed++;
      publish('processed', thread);
      // Yield between threads so the UI remains usable during a bulk import.
      await new Promise(resolve => setImmediate(resolve));
    }
    report.workspaces = workspaceIds.size;
    report.warnings = [...source.warnings, ...(overlap?.warnings.slice(0, 10) || []), ...[...deferredWarnings].slice(0, 20), ...[...attachmentWarnings].slice(0, 20)];
    if (attachmentWarnings.size > 20) report.warnings.push(`另有 ${attachmentWarnings.size - 20} 条附件提示，具体缺失原因保留在对应消息中。`);
    if (report.syncExisting) report.warnings.push('同一来源和工作目录复用已有副本增量追加；源端修订作为新版本标记，已有历史和 Harness 续聊保留。打开/运行或被占用的会话可稍后重试。');
    if (report.metadataOnly) report.warnings.push(`${report.metadataOnly} 条会话未找到本地正文，仅保留索引元数据。`);
    if (!report.dryRun && report.ungrouped) report.warnings.push('工作区关联服务不可用的会话仍已保存，可从未分组会话中查看。');
    audit.complete = true;
    report.attachmentAudit = audit.snapshot();
    publish('finished');
    return report;
  } finally { source.close(); }
}
