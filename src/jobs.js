import { importCodex, reportText } from './importer.js';

/** Human-readable receipt; the browser uses the registry-issued job id. */
export function jobReceipt(id, mode = 'import') {
  return { kind: 'success', text: `${mode.startsWith('delete') ? 'Codex 清理任务' : mode === 'preview' ? 'Codex 预览任务' : 'Codex 导入任务'}\n任务编号：${id}\n进度窗口会持续更新；关闭窗口后任务仍在后台继续。${mode === 'preview' ? '\n预览不会复制会话或附件，完成后点击「确认导入」才会写入。' : ''}` };
}

/** Start an unowned job so completion never wakes a model or depends on a chat. */
export function startImportJob(ctx, services, options, lifetime, onSettled, operation = importCodex) {
  let done;
  const id = ctx.jobs.start({
    kind: 'codex-import', label: options.taskMode?.startsWith('delete') ? '清理 Codex 导入副本' : options.taskMode === 'preview' ? '预览 Codex 对话' : 'Codex 对话导入',
    run(job) {
      const cancellation = new AbortController();
      const signal = AbortSignal.any([cancellation.signal, lifetime]);
      let latest = { mode: options.taskMode || 'import', phase: 'discovering', total: null, processed: 0, imported: 0, skipped: 0, recovered: 0, failed: 0, metadataOnly: 0 };
      const publish = update => {
        latest = { ...latest, ...update };
        // Narration is observer-only: no command polling and no model history.
        job.append(`${JSON.stringify(latest)}\n`, { channel: 'log' });
        job.updateProgress(`${latest.processed}/${latest.total ?? '?'} · ${latest.phase}`);
      };
      publish(latest);
      done = Promise.resolve().then(() => operation(services, { ...options, dryRun: options.taskMode === 'preview' }, signal, publish)).then(report => {
        const text = report.text || reportText(report);
        publish({ phase: report.failed.length ? 'failed' : 'completed', currentTitle: '',
          total: report.total, processed: report.processed, imported: report.imported, skipped: report.skipped,
          updated: report.updated || 0, deferred: report.deferred || 0, syncSummary: report.syncSummary,
          recovered: report.recovered, failed: report.failed.length, metadataOnly: report.metadataOnly,
          withBody: report.withBody || 0, attachmentImages: report.attachmentImages || 0,
          attachmentFiles: report.attachmentFiles || 0, attachmentMissing: report.attachmentMissing || 0,
          ...(report.destinationSummary ? { destinationSummary: report.destinationSummary } : {}),
          ...(report.attachmentAudit ? { attachmentAudit: report.attachmentAudit } : {}),
          ...(report.importProposal ? { importProposal: report.importProposal } : {}),
          ...(report.proposal ? { proposal: report.proposal } : {}),
          ...(report.deleted !== undefined ? { deleted: report.deleted, preserved: report.preserved, found: report.found } : {}),
          // Bound UI diagnostics, never the imported source content.
          text: text.length > 1600 ? `${text.slice(0, 1600)}\n（更多诊断已省略）` : text });
        return { status: report.failed.length ? 'failed' : 'completed', detail: `已处理 ${report.processed}/${report.total}；失败 ${report.failed.length}`, result: text };
      }, error => {
        const cancelled = signal.aborted;
        const text = cancelled
          ? options.taskMode === 'preview' ? '已取消预览，未复制任何会话或附件。再次执行 /codex-import preview 可重新扫描。'
            : options.taskMode === 'delete-plan' ? '已取消扫描，未删除任何内容。'
            : options.taskMode === 'delete' ? '已停止清理。已经删除的副本不会恢复，剩余副本尚未删除。Codex 源数据未修改。'
              : '已取消导入。已经完成的会话会保留；再次运行 /codex-import run 可以跳过已完成内容并接续导入。'
          : `${options.taskMode?.startsWith('delete') ? '清理停止' : options.taskMode === 'preview' ? '预览停止' : '导入停止'}：${error.message ?? String(error)}`;
        publish({ phase: cancelled ? 'cancelled' : 'failed', text });
        return { status: cancelled ? 'killed' : 'failed', detail: text };
      }).finally(onSettled);
      return { done, cancel(reason) { cancellation.abort(new Error(reason || '用户取消导入')); } };
    },
  });
  return { id, done, mode: options.taskMode || 'import' };
}
