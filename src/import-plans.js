import { randomUUID } from 'node:crypto';

/** A preview authorizes only its reviewed IDs and frozen options, never new chats. */
export class ImportPlans {
  constructor() { this.plans = new Map(); }
  create(sessionId, options, report) {
    const failed = new Set(report.failed.map(row => row.threadId));
    const threadIds = [...new Set(report.previewThreadIds || [])].filter(id => !failed.has(id));
    this.plans.clear();
    if (!threadIds.length) return undefined;
    const { taskMode, dryRun, ...original } = options;
    const frozen = structuredClone({ ...original, codexHome: report.sourceHome, threadIds,
      ...(report.importWorkspacePath ? { importWorkspacePath: report.importWorkspacePath } : {}) });
    const token = randomUUID(); const expiresAt = Date.now() + 15 * 60 * 1000;
    if (report.previewDestinations) {
      frozen.groupByProject = report.groupByProject;
      if (report.previewSyncTargets) frozen.reviewedSyncTargets = Object.fromEntries(threadIds.map(id => [id, report.previewSyncTargets[id]]));
      frozen.reviewedDestinations = Object.fromEntries(threadIds.map(id => [id, structuredClone(report.previewDestinations[id])]));
    }
    this.plans.set(token, { sessionId, options: frozen, expiresAt });
    return { token, expiresAt, count: threadIds.length, total: report.total,
      sourceHome: report.sourceHome, destinationPath: report.importWorkspacePath || '', destinationSummary: report.destinationSummary,
      workspaceTitle: report.workspaceTitle || '按原项目分组', groupByProject: frozen.groupByProject === true,
      syncExisting: report.syncExisting, syncSummary: report.syncSummary, withBody: report.withBody, metadataOnly: report.metadataOnly,
      importAttachments: frozen.importAttachments !== false,
      attachmentImages: report.attachmentImages || 0, attachmentFiles: report.attachmentFiles || 0,
      attachmentAudit: report.attachmentAudit, attachmentMissing: report.attachmentMissing || 0 };
  }
  confirm(token, sessionId) {
    const plan = this.plans.get(token);
    if (!plan || plan.sessionId !== sessionId || Date.now() > plan.expiresAt) {
      throw new Error('导入预览已失效，请重新执行 /codex-import preview 并确认');
    }
    this.plans.delete(token);
    return structuredClone(plan.options);
  }
}
