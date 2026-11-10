import { digest } from './source.js';

const text = value => ({ type: 'text', text: value });
const json = value => JSON.stringify(value, null, 2);
const stringParts = values => (values ?? []).map(v => typeof v === 'string' ? v : v?.text ?? json(v)).join('\n');

function userBlocks(content) {
  return (content ?? []).map(block => {
    if (typeof block === 'string') return text(block);
    if (['text', 'input_text', 'output_text'].includes(block.type)) return text(block.text ?? '');
    // Preserve paths/URLs and unsupported media descriptions, without inventing
    // Harness attachment receipts or fetching remote resources during import.
    return text(`[Codex ${block.type ?? 'attachment'}]\n${json(block)}`);
  });
}

function projectItem(item) {
  switch (item.type) {
    case 'userMessage': return { role: 'user', content: userBlocks(item.content) };
    case 'agentMessage': return { role: 'assistant', content: [text(item.text ?? '')] };
    case 'reasoning': {
      const value = stringParts(item.content?.length ? item.content : item.summary);
      return value ? { role: 'assistant', content: [{ type: 'reasoning', text: value }] } : undefined;
    }
    case 'commandExecution': return { role: 'assistant', content: [text(
      `[Codex 终端记录 · ${item.status ?? ''}]\n$ ${item.command ?? ''}\n目录: ${item.cwd ?? ''}\n${item.aggregatedOutput ?? ''}\n退出码: ${item.exitCode ?? '未知'}`)] };
    case 'fileChange': return { role: 'assistant', content: [text(`[Codex 文件变更]\n${json(item.changes ?? item)}`)] };
    case 'mcpToolCall': return { role: 'assistant', content: [text(
      `[Codex MCP · ${item.server}.${item.tool}]\n参数:\n${json(item.arguments)}\n结果:\n${json(item.result ?? item.error)}`)] };
    case 'dynamicToolCall': return { role: 'assistant', content: [text(
      `[Codex 工具 · ${item.namespace ?? ''}.${item.tool}]\n参数:\n${json(item.arguments)}\n结果:\n${json(item.contentItems ?? item.result ?? item.error)}`)] };
    case 'webSearch': return { role: 'assistant', content: [text(`[Codex 搜索]\n${json(item)}`)] };
    case 'imageView': return { role: 'assistant', content: [text(`[Codex 查看图片]\n${item.path ?? json(item)}`)] };
    case 'imageGeneration': return { role: 'assistant', content: [text(
      `[Codex 生成图片 · ${item.status ?? ''}]\n${item.revisedPrompt ?? ''}\n${item.savedPath ?? ''}\n原始图像结果保存在 codex-import/raw 事件中。`)] };
    case 'contextCompaction': return { role: 'assistant', content: [text('[Codex 上下文已压缩；本地可用的历史记录已保留。]')] };
    default: return { role: 'assistant', content: [text(`[Codex ${item.type ?? 'record'}]\n${json(item)}`)] };
  }
}

function legacyItems(records) {
  const hasResponses = records.some(r => r.item.type === 'response_item');
  return records.flatMap(record => {
    const { type, payload } = record.item;
    if (type === 'response_item' && payload) {
      if (payload.type === 'message') {
        if (payload.role === 'user') return [{ ...record, projected: { role: 'user', content: userBlocks(payload.content) } }];
        if (payload.role === 'assistant') return [{ ...record, projected: { role: 'assistant', content: userBlocks(payload.content) } }];
        return [];
      }
      if (payload.type === 'reasoning') {
        const value = stringParts(payload.summary ?? payload.content);
        return value ? [{ ...record, projected: { role: 'assistant', content: [{ type: 'reasoning', text: value }] } }] : [];
      }
      return [{ ...record, projected: { role: 'assistant', content: [text(`[Codex ${payload.type ?? 'record'}]\n${json(payload)}`)] } }];
    }
    if (!hasResponses && type === 'event_msg' && payload) {
      if (payload.type === 'user_message') return [{ ...record, projected: { role: 'user', content: [text(payload.message ?? '')] } }];
      if (payload.type === 'agent_message') return [{ ...record, projected: { role: 'assistant', content: [text(payload.message ?? '')] } }];
    }
    return [];
  });
}

/** Shared projection order for native conversion and attachment admission. */
export function projectedRecords(snapshot) {
  if (snapshot.mode === 'sqlite') return snapshot.records.map(record => ({ record, projected: projectItem(record.item) }));
  if (snapshot.mode === 'jsonl') return legacyItems(snapshot.supplemental).map(record => ({ record, projected: record.projected }));
  return [];
}

/** Stable namespace plus content digest: reruns never overwrite a resumed chat. */
export function sessionIdFor(home, snapshot) {
  return `codex-${digest([home, snapshot.thread.id, snapshot.destinationCwd ?? snapshot.thread.cwd ?? null]).slice(0, 24)}-${snapshot.fingerprint.slice(0, 24)}`;
}

/** Convert a snapshot to native messages and lossless, ignorable source records. */
export function convertSnapshot(home, snapshot, version) {
  const id = snapshot.targetSessionId || sessionIdFor(home, snapshot);
  const events = [];
  const add = (type, data, time = snapshot.createdAt, surface = false) => {
    const event = { seq: events.length, type, time, data };
    if (surface) event.surfaceOp = 'append';
    if (type.startsWith('codex-import/')) event.ignorable = true;
    events.push(event);
  };
  add('codex-import/source', { format: 1, codexHome: home, threadId: snapshot.thread.id,
    fingerprint: snapshot.fingerprint, mode: snapshot.mode, metadata: snapshot.thread, turns: snapshot.turns,
    ...(snapshot.sourceFingerprint ? { sourceFingerprint: snapshot.sourceFingerprint, attachmentFormat: 1, attachments: snapshot.attachmentSummary } : {}),
    destinationCwd: snapshot.destinationCwd ?? snapshot.thread.cwd ?? null,
    notice: '历史记录导入；工具记录为文本，不会重新执行。' });
  add('session/title', { title: snapshot.thread.title?.trim() || `Codex ${snapshot.thread.id}`,
    messageSeqs: [], source: { kind: 'user' } });

  for (const record of snapshot.records) add('codex-import/raw', { storage: 'sqlite', ...record }, record.time);
  for (const record of snapshot.supplemental) add('codex-import/raw', { storage: 'jsonl', ...record }, record.time);

  let turn = 0;
  let step = 0;
  let opened = false;
  let hasHead = false;
  let lastTime = snapshot.createdAt;
  const emit = (record, projected) => {
    if (!projected || !projected.content.length) return;
    const time = record.time || snapshot.createdAt;
    if (projected.role === 'user' || !opened) {
      if (opened) {
        add('step/end', { turn, step }, lastTime);
        add('turn/end', { turn, reason: { kind: 'completed' } }, lastTime);
      }
      turn++; step = 1; opened = true;
      add('turn/start', { turn }, time);
      add('step/start', { turn, step }, time);
    }
    if (!hasHead && !snapshot.suppressHead) {
      add('system/message', { turn, step, message: { id: `codex-system-${digest(id).slice(0, 24)}`,
        role: 'system', source: { kind: 'system-prompt' }, content: [] } }, time, true);
      hasHead = true;
    }
    const message = { id: `codex-message-${digest([id, record.key]).slice(0, 32)}`, ...projected,
      source: projected.role === 'user' ? { kind: 'user' }
        : { kind: 'model', provider: snapshot.thread.model_provider || 'codex', model: snapshot.thread.model || 'codex-import' } };
    if (projected.role === 'user') add('user/message', message, time, true);
    else {
      // Codex does not retain the original provider delta timing. This is an
      // explicit reconstructed stream matching the imported message content.
      const stream = message.content.flatMap((block, index) => [
        { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } },
        ...(['text', 'reasoning'].includes(block.type) ? [{ type: `${block.type}-chunks`, time0: time, index, dt: [], texts: [block.text] }] : []),
        { type: 'chunk', time, chunk: { type: 'block-end', index, block } },
      ]);
      stream.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } });
      add('assistant/message', { turn, step, message, stream }, time, true);
      if (projected.files?.length) add('codex-import/files', { files: projected.files }, time);
      add('step/end', { turn, step }, time);
      step++;
      add('step/start', { turn, step }, time);
    }
    lastTime = time;
  };
  if (!snapshot.skipLocationNotice && snapshot.destinationCwd && snapshot.destinationCwd !== snapshot.thread.cwd) {
    emit({ key: 'import-location', time: snapshot.createdAt }, { role: 'assistant', content: [text(
      `【Codex 导入信息】\n来源项目：${snapshot.thread.project?.title ?? snapshot.thread.project?.name ?? snapshot.thread.cwd ?? '未知项目'}\n原始工作目录：${snapshot.thread.cwd ?? '未知'}\n原会话 ID：${snapshot.thread.id}\n${snapshot.destinationKind === 'original' ? `原项目目录规范化后为：${snapshot.destinationCwd}。可在此工作目录继续开发。` : '此会话归入专用导入工作区，原项目文件未移动。继续开发时，请切换到原项目工作区。'}`)] });
  }
  if (snapshot.projectedEntries || snapshot.mode !== 'metadata-only') {
    for (const { record, projected } of (snapshot.projectedEntries || projectedRecords(snapshot))) emit(record, snapshot.mediaMessages?.get(record.key) ?? projected);
  } else {
    emit({ key: 'missing-body', time: snapshot.createdAt }, { role: 'assistant', content: [text(
      '此 Codex 对话只剩本地索引，未找到消息正文。已保留原始标题、目录与元数据；无法恢复未存于本机的内容。')] });
  }
  if (opened) {
    add('step/end', { turn, step }, lastTime);
    add('turn/end', { turn, reason: { kind: 'completed' } }, lastTime);
  }
  add('codex-import/complete', { format: 1, fingerprint: snapshot.fingerprint,
    originalThreadId: snapshot.thread.id, mode: snapshot.mode }, lastTime);
  const header = { version, id, createdAt: snapshot.createdAt, isSeeded: false };
  if (snapshot.destinationCwd ?? snapshot.thread.cwd) header.cwd = snapshot.destinationCwd ?? snapshot.thread.cwd;
  return { header, events };
}
