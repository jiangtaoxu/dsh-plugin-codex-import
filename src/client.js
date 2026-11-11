import { attachmentSummaryText, createAttachmentDetails } from './attachment-details.js';
import { installPresentation } from './presentation.js';

export const name = 'codex-import-results';
export const inject = ['commandUi', 'jobs', 'remote', 'remote.commands', 'slots', 'uiConversation', 'sessions', 'workspaces', 'uiWorkspace', 'layout'];

const PHASES = { attachments: '正在复制图片与附件', discovering: '正在扫描本地会话', ready: '准备导入', reading: '读取会话', converting: '转换消息', writing: '写入 Harness', grouping: '关联工作区', processed: '继续下一条', finished: '整理结果', completed: '导入完成', cancelled: '已取消', failed: '导入未完成', 'cleanup-scanning': '核对导入副本与续聊', deleting: '删除 Harness 副本' };

/** Read the latest complete progress record from the bounded job output tail. */
export function latestProgress(text) {
  const lines = (text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value.phase === 'string' && typeof value.processed === 'number') return value;
    } catch (error) {
      // A retained output tail can start in the middle of an older JSON line.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
}

/** Observe Harness jobs without adding polling commands or model messages. */
export function apply(ctx) {
  const presentation = installPresentation(ctx);
  const refreshedJobs = new Set();
  const element = (tag, label) => {
    const node = document.createElement(tag);
    if (label) node.setAttribute('aria-label', label);
    return node;
  };
  const dialog = element('dialog', 'Codex 导入进度与结果');
  dialog.style.cssText = 'width:min(720px,90vw);max-height:85vh;padding:28px;border:1px solid #ddd;border-radius:18px;background:#fff;color:#1d2433;box-shadow:0 20px 80px #0003;font:15px/1.7 system-ui,sans-serif;';
  const heading = element('h2');
  heading.textContent = 'Codex 导入结果';
  heading.style.cssText = 'margin:0 0 16px;font-size:20px;';
  const progress = element('progress', '导入进度');
  progress.style.cssText = 'width:100%;height:14px;accent-color:#5146db;';
  progress.hidden = true;
  const summary = element('p', '导入统计');
  summary.style.cssText = 'white-space:pre-line;';
  summary.setAttribute('aria-live', 'polite');
  const current = element('p', '当前会话');
  current.style.cssText = 'color:#687082;overflow-wrap:anywhere;';
  const output = element('pre', '导入详细结果');
  output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:40vh;font:inherit;user-select:text;';
  const actions = element('div');
  const confirmation = element('section', '删除确认');
  confirmation.hidden = true;
  confirmation.style.cssText = 'border:1px solid #e5c8bc;border-radius:12px;padding:16px;background:#fff9f6;';
  const choiceLabel = element('label');
  choiceLabel.style.cssText = 'display:flex;align-items:flex-start;gap:10px;';
  const includeContinued = element('input', '同时删除包含 Harness 新增续聊的导入副本');
  includeContinued.type = 'checkbox'; includeContinued.checked = false;
  const choiceText = element('span');
  choiceLabel.append(includeContinued, choiceText);
  const challenge = element('p', '删除确认说明');
  const confirmationInput = element('input', '输入删除确认文字');
  confirmationInput.type = 'text'; confirmationInput.autocomplete = 'off';
  confirmationInput.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid #d8c2ba;border-radius:8px;font:inherit;';
  const deleteButton = element('button');
  deleteButton.type = 'button'; deleteButton.textContent = '确认删除 Harness 副本'; deleteButton.disabled = true;
  deleteButton.style.cssText = 'margin-top:14px;padding:9px 18px;border:0;border-radius:8px;background:#b53324;color:white;font:inherit;cursor:pointer;';
  confirmation.append(choiceLabel, challenge, confirmationInput, deleteButton);
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;margin-top:20px;';
  const cancel = element('button');
  cancel.type = 'button'; cancel.textContent = '取消导入'; cancel.hidden = true;
  const close = element('button');
  close.type = 'button'; close.textContent = '关闭';
  for (const button of [cancel, close]) button.style.cssText = 'padding:8px 24px;border:1px solid #ddd;border-radius:9px;background:#fff;color:#303548;font:inherit;cursor:pointer;';
  close.style.cssText += 'background:#5146db;color:white;border-color:#5146db;';
  actions.append(cancel, close);
  const importConfirmation = element('section', '导入确认');
  importConfirmation.hidden = true;
  importConfirmation.style.cssText = 'border:1px solid #d8d4f3;border-radius:12px;padding:16px;background:#f7f6ff;';
  const importScope = element('p', '本次导入范围');
  importScope.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 12px;';
  const importButton = element('button', '确认导入');
  importButton.type = 'button'; importButton.textContent = '确认导入';
  importButton.style.cssText = 'padding:9px 18px;border:0;border-radius:8px;background:#5146db;color:white;font:inherit;cursor:pointer;';
  importConfirmation.append(importScope, importButton);
  const attachmentButton = element('button', '查看附件明细');
  attachmentButton.type = 'button'; attachmentButton.textContent = '查看附件统计与明细';
  attachmentButton.style.cssText = 'margin-top:12px;padding:8px 16px;border:1px solid #d8d4f3;border-radius:8px;background:#f7f6ff;color:#393075;font:inherit;cursor:pointer;';
  dialog.append(heading, progress, summary, current, importConfirmation, attachmentButton, output, confirmation, actions);
  document.body.append(dialog);
  const attachmentDetails = createAttachmentDetails(attachmentButton);
  let tracking;
  let releases = [];
  let timer;
  let disposed = false;
  let cancelling = false;
  let proposal;
  let confirming = false;
  let importProposal;
  let importing = false;
  const updateChoice = () => {
    if (!proposal) return;
    const count = includeContinued.checked ? proposal.count : proposal.plainCount;
    const phrase = `删除 ${count} 条会话`;
    choiceText.textContent = `同时删除 ${proposal.continuedCount} 条包含 Harness 新增续聊的副本（默认保留）`;
    challenge.textContent = `将永久删除 ${count} 条 Harness 会话副本。Codex 源数据不受影响。请输入「${phrase}」确认：`;
    confirmationInput.placeholder = phrase;
    deleteButton.disabled = confirming || count === 0 || confirmationInput.value !== phrase;
  };
  const release = () => {
    clearInterval(timer); timer = undefined;
    const old = releases; releases = [];
    for (const dispose of old) dispose();
  };
  const show = () => {
    if (!dialog.open) dialog.showModal();
    close.focus();
  };
  const render = () => {
    if (!tracking || disposed) return;
    const state = ctx.jobs.state.getSnapshot();
    const row = (state.rows[tracking.sessionId] || []).find(job => job.id === tracking.id);
    const observed = state.observed[tracking.id];
    const data = latestProgress(observed?.text) || tracking.latest;
    if (data) tracking.latest = data;
    const terminal = row && ['completed', 'failed', 'killed'].includes(row.status);
    const finished = terminal || ['completed', 'failed', 'cancelled'].includes(data?.phase);
    const elapsed = Math.max(0, Math.floor(((row?.finishedAt || Date.now()) - (row?.startedAt || tracking.startedAt)) / 1000));
    const terminalPhase = row?.status === 'killed' ? 'cancelled' : row?.status;
    const phase = terminal && !['completed', 'failed', 'cancelled'].includes(data?.phase) ? terminalPhase : data?.phase;
    const mode = data?.mode || tracking.mode;
    const cleanup = mode?.startsWith('delete');
    const preview = mode === 'preview';
    attachmentDetails.update(cleanup ? undefined : data?.attachmentAudit);
    output.style.maxHeight = preview && finished ? '12vh' : '40vh';
    heading.textContent = cleanup
      ? data?.proposal ? '删除前确认' : finished ? phase === 'cancelled' ? '已取消清理' : phase === 'failed' ? '清理未完成' : '清理完成'
        : cancelling ? '正在停止清理…' : mode === 'delete-plan' ? '正在扫描导入副本' : '正在删除 Harness 副本'
      : preview ? finished ? phase === 'cancelled' ? '已取消预览' : data?.importProposal ? '预览完成，请确认导入' : phase === 'failed' ? '预览未完成' : '预览完成'
        : cancelling ? '正在取消预览…' : `正在预览 ${data?.sourceKind === 'chatgpt' ? 'ChatGPT' : 'Codex'} 对话`
      : finished ? PHASES[phase] || '导入已结束' : cancelling ? '正在取消导入…' : `正在导入 ${data?.sourceKind === 'chatgpt' ? 'ChatGPT' : 'Codex'} 对话`;
    progress.hidden = false;
    if (typeof data?.total === 'number') {
      progress.max = Math.max(1, data.total); progress.value = data.processed;
      const percent = data.total ? Math.floor(data.processed / data.total * 1000) / 10 : 100;
      summary.textContent = `已处理 ${data.processed} / ${data.total}（${percent}%） · 用时 ${elapsed} 秒\n新建 ${data.imported} · 增量更新 ${data.updated || 0} · 待重试 ${data.deferred || 0} · 已存在 ${data.skipped} · 续传 ${data.recovered} · 失败 ${data.failed} · 仅索引 ${data.metadataOnly}`;
      if (preview) summary.textContent = `已检查 ${data.processed} / ${data.total}（${percent}%） · 用时 ${elapsed} 秒\n有正文 ${data.withBody || 0} · 仅索引 ${data.metadataOnly || 0} · 失败 ${data.failed || 0}\n${attachmentSummaryText(data.attachmentAudit, data)}`;
      if (!cleanup && !preview && data.attachmentAudit) summary.textContent += '\n' + attachmentSummaryText(data.attachmentAudit, data);
      if (preview && data.syncSummary) summary.textContent += `\n预计新增 ${data.syncSummary.new} · 源变化 ${data.syncSummary.changed} · 源未变化 ${data.syncSummary.unchanged}`;
      if (data.sourceSummary) {
        const s = data.sourceSummary;
        summary.textContent += `\nChatGPT：${s.shards} 个对话文件 · 当前路径 ${s.selectedMessages} 条消息 · 其他分支 ${s.offPathMessages} 条（保留原始记录）`;
        if (s.unsupported?.length) summary.textContent += `\n未单独导入：${s.unsupported.join('、')}`;
      }
      if (data.overlap) summary.textContent += `\n与 dsh 内容重合：文本序列相同 ${data.overlap.exactConversations} 条 · 含相同长消息 ${data.overlap.sharedConversations} 条；跨来源保留双方，不自动合并。${data.overlap.failed ? `另有 ${data.overlap.failed} 条会话未能读取。` : ''}`;
      if (!cleanup && data.destinationSummary) {
        const d = data.destinationSummary;
        summary.textContent += `\n工作目录：${d.mode === 'original' ? `原项目 ${d.originalSessions} 条 / ${d.originalProjects} 个目录；回退 ${d.fallbackSessions} 条` : `统一目录 ${d.fallbackSessions} 条`}`;
      }
      if (cleanup) summary.textContent = mode === 'delete-plan'
        ? `已核对 ${data.processed} / ${data.total} · 找到 ${data.found || 0} 条导入副本 · 用时 ${elapsed} 秒`
        : `已处理 ${data.processed} / ${data.total} · 已删除 ${data.deleted || 0} · 保留续聊 ${data.preserved || 0} · 失败 ${data.failed || 0}`;
    } else {
      progress.removeAttribute('value');
      summary.textContent = `正在确定会话总数 · 用时 ${elapsed} 秒`;
    }
    current.textContent = finished ? '' : `${preview && data?.phase === 'attachments' ? '正在检查图片与附件' : PHASES[data?.phase] || '正在连接任务'}${data?.currentTitle ? `：${data.currentTitle}` : ''}`;
    output.textContent = observed?.error ? `连接暂时中断：${observed.error}\n可执行 /codex-import status 重新查看任务。`
      : data?.text || (terminal ? row.detail || '任务已结束。' : preview ? '预览只读取本地数据，不复制会话或附件。可关闭窗口，稍后用 /codex-import status 查看并确认。' : data?.totalEvents ? `当前会话已写入 ${data.writtenEvents || 0} / ${data.totalEvents} 条记录` : '导入期间可以关闭此窗口，任务会在后台继续。');
    cancel.hidden = !!finished; cancel.disabled = !!cancelling;
    cancel.textContent = cleanup ? mode === 'delete-plan' ? '取消扫描' : '停止清理' : preview ? '取消预览' : '取消导入';
    confirmation.hidden = !data?.proposal;
    if (data?.proposal) {
      if (proposal?.token !== data.proposal.token) {
        proposal = data.proposal; includeContinued.checked = false; confirmationInput.value = '';
      }
      updateChoice();
    }
    importProposal = preview && finished ? data?.importProposal : undefined;
    importConfirmation.hidden = !importProposal;
    if (importProposal) {
      const p = importProposal;
      importScope.textContent = `确认导入本次已检查的 ${p.count} 条会话（有正文 ${p.withBody}，仅索引 ${p.metadataOnly}）。\n来源：${p.sourceHome}\n目标：${p.groupByProject ? `现有原项目 ${p.destinationSummary?.originalSessions ?? '—'} 条；无有效原目录 ${p.destinationSummary?.fallbackSessions ?? '—'} 条 → ${p.destinationPath}` : `${p.workspaceTitle}（${p.destinationPath}）`}\n${p.importAttachments ? attachmentSummaryText(data?.attachmentAudit || p.attachmentAudit, p) : '本次不复制附件'}\n${p.sourceKind === 'chatgpt' ? '确认时校验导出包内容；归档变化需要重新预览。' : '确认后读取上述会话的最新内容。'}工作目录按本次预览锁定，原目录变化需重新预览。${p.syncExisting === false ? '本次使用独立快照模式；相同快照跳过，来源或附件变化时创建新副本。' : '同目录的已有副本增量追加，保留原消息与 Harness 续聊；修订单独标记，未变化跳过，打开或占用的会话稍后重试。'}\n确认有效期至 ${new Date(p.expiresAt).toLocaleTimeString()}。`;
      importButton.disabled = importing || Date.now() > p.expiresAt;
    }
    close.textContent = importProposal ? '暂不导入' : finished ? '关闭' : '后台运行';
    if (finished && ['import', 'delete'].includes(mode) && !refreshedJobs.has(tracking.id)) {
      refreshedJobs.add(tracking.id);
      if (refreshedJobs.size > 50) refreshedJobs.delete(refreshedJobs.values().next().value);
      void presentation.refresh().catch(error => { if (!disposed) output.textContent += `\n会话列表刷新失败：${error.message}。可点击侧栏「刷新」重试，无需重新导入。`; });
    }
    if (terminal) { clearInterval(timer); timer = undefined; }
  };
  const onClose = () => { dialog.close(); if (cancel.hidden) { release(); tracking = undefined; } };
  const onCancel = async () => {
    if (!tracking || cancelling) return;
    cancelling = true; render();
    try {
      const result = await ctx.jobs.kill(tracking.sessionId, tracking.id);
      if (!result.ok) { cancelling = false; output.textContent = `取消失败：${result.error.message}`; cancel.disabled = false; }
    } catch (error) { cancelling = false; output.textContent = `取消失败：${error.message}`; cancel.disabled = false; }
  };
  const onConfirm = async () => {
    updateChoice();
    if (!tracking || !proposal || deleteButton.disabled) return;
    confirming = true; updateChoice();
    try {
      const request = { token: proposal.token, includeContinued: !!includeContinued.checked, confirmation: confirmationInput.value };
      const response = await ctx.remote.commands.execute(tracking.sessionId, `/codex-import delete-confirm ${JSON.stringify(request)}`, []);
      if (!response.ok) throw new Error(response.error.message);
      if (!response.value) throw new Error('清理指令未匹配');
      handleResult(tracking.sessionId, 'codex-import', response.value.result);
    } catch (error) { output.textContent = `清理未开始：${error.message}`; }
    finally { confirming = false; updateChoice(); }
  };
  const onImport = async () => {
    if (!tracking || !importProposal || importing || importButton.disabled) return;
    if (Date.now() > importProposal.expiresAt) { importButton.disabled = true; output.textContent = '预览已过期，请重新执行 /codex-import preview。'; return; }
    importing = true; importButton.disabled = true;
    const sessionId = tracking.sessionId;
    try {
      const response = await ctx.remote.commands.execute(sessionId, `/codex-import import-confirm ${JSON.stringify({ token: importProposal.token })}`, []);
      if (!response.ok) throw new Error(response.error.message);
      if (!response.value) throw new Error('导入指令未匹配');
      handleResult(sessionId, 'codex-import', response.value.result);
    } catch (error) { output.textContent = `导入未开始：${error.message}。可重新预览后确认。`; }
    finally { importing = false; }
  };
  close.addEventListener('click', onClose);
  cancel.addEventListener('click', onCancel);
  includeContinued.addEventListener('change', updateChoice);
  confirmationInput.addEventListener('input', updateChoice);
  deleteButton.addEventListener('click', onConfirm);
  importButton.addEventListener('click', onImport);
  ctx.effect(() => () => {
    disposed = true; release(); attachmentDetails.dispose();
    close.removeEventListener('click', onClose);
    cancel.removeEventListener('click', onCancel);
    includeContinued.removeEventListener('change', updateChoice);
    confirmationInput.removeEventListener('input', updateChoice);
    deleteButton.removeEventListener('click', onConfirm);
    importButton.removeEventListener('click', onImport);
    dialog.remove();
  });
  const handleResult = (sessionId, commandName, result) => {
    if (commandName !== 'codex-import') return;
    const id = /任务编号：(codex-import-[a-f0-9]+)/.exec(result.text || '')?.[1];
    if (id) {
      release(); cancelling = false; attachmentDetails.update(undefined);
      proposal = undefined; confirmation.hidden = true;
      importProposal = undefined; importConfirmation.hidden = true;
      tracking = { id, sessionId, startedAt: Date.now(), mode: result.text?.includes('清理') ? 'delete-plan' : result.text?.includes('预览任务') ? 'preview' : 'import' };
      releases.push(ctx.jobs.state.subscribe(render));
      releases.push(ctx.jobs.watchRows(sessionId));
      releases.push(ctx.jobs.observe(undefined, id));
      timer = setInterval(render, 1000);
      render(); show();
      return;
    }
    if (tracking && !cancel.hidden) return; // Keep a running job's progress visible.
    release(); tracking = undefined; attachmentDetails.update(undefined);
    proposal = undefined; confirmation.hidden = true;
    importProposal = undefined; importConfirmation.hidden = true;
    progress.hidden = true; summary.textContent = ''; current.textContent = ''; cancel.hidden = true;
    heading.textContent = result.kind === 'error' ? 'Codex 导入未完成' : 'Codex 导入结果';
    output.textContent = result.text || '操作已完成。'; close.textContent = '关闭';
    show();
  };
  ctx.on('command/executed', handleResult);
}
