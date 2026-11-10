import z from '@deepseek-ai/schemastery';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { importCodex } from './importer.js';
import { startImportJob, jobReceipt } from './jobs.js';
import { CleanupPlans, deleteImported } from './cleanup.js';
import { ImportCatalog, installCatalogRoute, warmNativeCache } from './catalog.js';
import { AttachmentAudits, installAttachmentAuditRoute } from './attachment-audit.js';
import { ImportPlans } from './import-plans.js';

export const name = 'codex-import';
export const inject = ['commands', 'sessionPersistence', 'workspaceRegistry', 'jobs', 'agents', 'sessions', 'sessionProjectionCache', 'sessionTitle', 'connection', 'attachments'];
export const Config = z.object({
  codexHome: z.string().description('Codex 数据目录；留空使用 CODEX_HOME 或 ~/.codex').default(''),
  includeArchived: z.boolean().description('包含已归档的 Codex 会话').default(true),
  syncExisting: z.boolean().description('增量同步同目录的已有导入副本，保留 Harness 续聊；关闭则使用独立快照模式').default(true),
  preserveArchive: z.boolean().description('保留归档和置顶状态').default(true),
  groupByProject: z.boolean().description('优先复用现有原项目目录；不存在时回退到 Codex 导入目录').default(true),
  importWorkspacePath: z.string().description('统一导入工作区的实际目录；默认 $DSH_HOME/imports/codex').default(''),
  workspaceTitle: z.string().description('统一导入工作区在侧栏显示的名称').default('Codex 导入'),
  harnessSessionRoot: z.string().description('清理操作允许访问的 Harness 会话存储根目录；默认 $DSH_HOME/sessions').default(''),
  importAttachments: z.boolean().description('复制可恢复的图片与显式附件到 Harness 原生附件存储').default(true),
  maxAttachmentBytes: z.number().step(1).min(1).description('单个本地附件的复制大小上限；图片还遵循 Harness 自身限制').default(104857600),
});

/** Register a human command. Import never invokes a model or replays tools. */
export function apply(ctx, config = {}) {
  let currentJob;
  let lastJob;
  const lifetime = new AbortController();
  const cleanup = new CleanupPlans(config.harnessSessionRoot);
  const previews = new ImportPlans();
  const audits = new AttachmentAudits();
  const services = () => ({ sessionPersistence: ctx.sessionPersistence, workspaceRegistry: ctx.workspaceRegistry,
    formatVersion: SESSION_FORMAT_VERSION, agents: ctx.agents, sessions: ctx.sessions, sessionProjectionCache: ctx.sessionProjectionCache, attachments: ctx.attachments,
    createAttachmentAudit: () => audits.create(),
    warmCache: (header, events, signal) => warmNativeCache(ctx, header, events, signal) });
  const catalog = new ImportCatalog(services());
  const refreshCatalog = () => {
    catalog.invalidate();
    return catalog.ensure(lifetime.signal, true).catch(error => {
      if (!lifetime.signal.aborted) ctx.logger?.warn(`Codex 导入目录读取失败：${error.message}`);
    });
  };
  if (ctx.connection?.fetch) {
    ctx.effect(() => installAttachmentAuditRoute(ctx, audits));
    ctx.effect(() => installCatalogRoute(ctx, catalog, lifetime.signal));
    void refreshCatalog();
  }
  const launch = (operation, options) => {
    currentJob = startImportJob(ctx, services(), options, lifetime.signal, () => {
      currentJob = undefined;
      if (ctx.connection?.fetch && !['delete-plan', 'preview'].includes(options.taskMode)) void refreshCatalog();
    }, operation);
    lastJob = currentJob;
    return jobReceipt(currentJob.id, currentJob.mode);
  };
  ctx.jobs.attachController('codex-import');
  ctx.on('dispose', () => {
    lifetime.abort(new Error('Codex import plugin unloaded'));
    previews.plans.clear();
    audits.reports.clear();
    return Promise.allSettled([currentJob?.done, catalog.running]);
  });
  ctx.commands.register({
    name: 'codex-import',
    description: '本机 Codex 聊天：preview / sync 预览后确认增量导入 / run 预览 / delete 清理副本',
    input: { hint: 'preview | sync | run [JSON 选项] | status | cancel | delete' },
    recordInput: false,
    async handler({ rawInput, signal, agent }) {
      const verb = rawInput.trim();
      if (verb === 'status') return lastJob ? jobReceipt(lastJob.id, lastJob.mode) : { kind: 'success', text: '当前没有 Codex 导入任务。' };
      if (verb === 'cancel') {
        if (!currentJob) return { kind: 'success', text: '当前没有正在运行的导入任务。' };
        ctx.jobs.kill(currentJob.id, undefined, '用户取消导入');
        return jobReceipt(currentJob.id, currentJob.mode);
      }
      if (currentJob) return jobReceipt(currentJob.id, currentJob.mode);
      const match = /^\s*(preview|run|sync|import-confirm|delete|delete-confirm)(?:\s+([\s\S]+))?\s*$/.exec(rawInput);
      if (!match) return { kind: 'error', text: '使用 /codex-import preview 预览，完成后点击「确认导入」。run 也会先预览。' };
      let extra = {};
      try {
        if (match[2]) extra = JSON.parse(match[2]);
        if (match[1] === 'import-confirm') {
          if (!extra || typeof extra !== 'object' || Array.isArray(extra) || typeof extra.token !== 'string'
            || Object.keys(extra).some(key => key !== 'token')) throw new Error('导入确认只接受本次预览的确认编号');
        } else if (match[1] === 'delete-confirm') {
          if (!extra || typeof extra !== 'object' || typeof extra.token !== 'string'
            || typeof extra.confirmation !== 'string' || typeof extra.includeContinued !== 'boolean') throw new Error('删除确认参数无效');
        } else if (match[1] === 'delete') {
          if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('选项必须是 JSON 对象');
          if (Object.keys(extra).length) throw new Error('删除预览不接受筛选参数，请在确认界面选择范围');
        } else validateOptions(extra);
      } catch (error) { return { kind: 'error', text: `导入选项无效：${error.message}` }; }
      if (match[1] === 'delete' || match[1] === 'delete-confirm') {
        try {
          if (/^codex-(?:[a-f0-9]{24}-[a-f0-9]{24}|recovered-[a-f0-9]{24})$/.test(agent.session.id)) {
            return { kind: 'error', text: '请新建一个 Harness 会话后执行 /codex-import delete，避免清理命令写入正在删除的导入副本。尚未删除任何内容。' };
          }
          if (match[1] === 'delete') return launch(
            (service, _options, jobSignal, progress) => cleanup.scan(service, agent.session.id, jobSignal, progress),
            { taskMode: 'delete-plan' });
          const plan = cleanup.confirm(extra.token, agent.session.id, extra.includeContinued, extra.confirmation);
          return launch((service, _options, jobSignal, progress) => deleteImported(service, plan, jobSignal, progress),
            { taskMode: 'delete' });
        } catch (error) { return { kind: 'error', text: `清理未开始：${error.message}` }; }
      }
      if (match[1] === 'import-confirm') {
        try {
          const options = previews.confirm(extra.token, agent.session.id);
          return launch(undefined, { ...options, taskMode: 'import' });
        } catch (error) { return { kind: 'error', text: `导入未开始：${error.message}` }; }
      }
      try {
        const owner = agent.session.id;
        return launch(async (service, options, jobSignal, progress) => {
          const report = await importCodex(service, { ...options, dryRun: true }, jobSignal, progress);
          jobSignal.throwIfAborted();
          report.importProposal = previews.create(owner, options, report);
          return report;
        }, { ...config, ...extra, taskMode: 'preview' });
      } catch (error) { return { kind: 'error', text: `无法启动预览：${error.message}` }; }
    },
  });
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('选项必须是 JSON 对象');
  const allowed = new Set(['codexHome', 'cwd', 'threadIds', 'includeArchived', 'preserveArchive',
    'groupByProject', 'importWorkspacePath', 'workspaceTitle', 'importAttachments', 'maxAttachmentBytes', 'syncExisting']);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw new Error(`未知选项 ${key}`);
    if (['codexHome', 'cwd', 'importWorkspacePath', 'workspaceTitle'].includes(key) && typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
    if (['includeArchived', 'preserveArchive', 'groupByProject', 'importAttachments', 'syncExisting'].includes(key) && typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    if (key === 'maxAttachmentBytes' && (!Number.isSafeInteger(value) || value < 1)) throw new Error('maxAttachmentBytes 必须是正整数');
    if (key === 'threadIds' && (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id))) {
      throw new Error('threadIds 必须是非空字符串组成的数组');
    }
  }
}
