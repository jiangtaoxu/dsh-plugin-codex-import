window.__ModuleLoader__.load({
  id: 'dsh-plugin-codex-import',
  factory: (require) => {
const React = require('react');

const QUESTION_REPLY_OPEN = '<send_user_message_question_reply>';
const QUESTION_REPLY_CLOSE = '</send_user_message_question_reply>';
const QUESTION_REPLY_NODE = 'codex-question-reply';
const QUESTION_REPLY_LIMIT = 1024 * 1024;

/** Explicit Markdown examples remain text rather than becoming historical replies. */
function questionReplyIsCode(text, at) {
  let fence;
  const before = text.slice(0, at);
  const lines = before.split(/\r?\n/);
  for (const line of lines.slice(0, -1)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = { char: marker[1][0], size: marker[1].length };
    else if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = undefined;
  }
  if (fence) return true;
  let inline;
  const line = lines.at(-1);
  for (const marker of line.matchAll(/(?<!\\)`+/g)) {
    if (!inline) inline = marker[0].length;
    else if (inline === marker[0].length) inline = undefined;
  }
  return inline !== undefined;
}

function questionReplyRows(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return undefined;
  const rows = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, 'question')
      || typeof item.question !== 'string' || !item.question.trim() || !Object.hasOwn(item, 'answer')) return undefined;
    const values = Array.isArray(item.answer) ? item.answer : item.answer === null ? [] : [item.answer];
    if (values.some(answer => !['string', 'number', 'boolean'].includes(typeof answer)
      || (typeof answer === 'number' && !Number.isFinite(answer)))) return undefined;
    rows.push({ question: item.question, answers: values.map(String) });
  }
  return rows;
}

/** Scan JSON strings and brackets so a literal closing tag in an answer is harmless. */
function questionReplyAt(text, start) {
  let cursor = start + QUESTION_REPLY_OPEN.length;
  const limit = Math.min(text.length, start + QUESTION_REPLY_LIMIT);
  while (cursor < limit && /\s/.test(text[cursor])) cursor++;
  let fence;
  const wrapping = /^(?:`{3,}|~{3,})[^\r\n]*\r?\n/.exec(text.slice(cursor, Math.min(limit, cursor + 160)));
  if (wrapping) {
    fence = /^[`~]+/.exec(wrapping[0])[0]; cursor += wrapping[0].length;
    while (cursor < limit && /\s/.test(text[cursor])) cursor++;
  }
  if (text[cursor] !== '[') return undefined;
  const jsonStart = cursor;
  let depth = 0, quoted = false, escaped = false, jsonEnd;
  for (; cursor < limit; cursor++) {
    const char = text[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) { jsonEnd = ++cursor; break; }
    }
  }
  if (jsonEnd === undefined) return undefined;
  while (cursor < limit && /\s/.test(text[cursor])) cursor++;
  if (fence) {
    if (!text.startsWith(fence, cursor)) return undefined;
    cursor += fence.length;
    while (cursor < limit && /\s/.test(text[cursor])) cursor++;
  }
  if (!text.startsWith(QUESTION_REPLY_CLOSE, cursor)) return undefined;
  let rows;
  try { rows = questionReplyRows(JSON.parse(text.slice(jsonStart, jsonEnd))); }
  catch { return undefined; }
  return rows ? { start, end: cursor + QUESTION_REPLY_CLOSE.length, rows } : undefined;
}

/** Return one validated original-text span; failures are left to the native text renderer. */
function findQuestionReply(text, from = 0) {
  for (let at = text.indexOf(QUESTION_REPLY_OPEN, from); at !== -1; at = text.indexOf(QUESTION_REPLY_OPEN, at + QUESTION_REPLY_OPEN.length)) {
    if (questionReplyIsCode(text, at)) continue;
    const parsed = questionReplyAt(text, at);
    if (parsed) return parsed;
  }
  return undefined;
}

/** A UserText rule preserves native message identity, selection, attachments and actions. */
const questionReplyRule = {
  id: QUESTION_REPLY_NODE, order: 5,
  match(text, from) {
    const parsed = findQuestionReply(text, from);
    return parsed ? { id: QUESTION_REPLY_NODE, start: parsed.start, end: parsed.end, data: { rows: parsed.rows } } : undefined;
  },
};

function QuestionReplyView({ node, raw }) {
  const [expanded, setExpanded] = React.useState(false);
  const rows = node.data.rows;
  const element = React.createElement;
  return element('span', { className: 'codex-question-reply', role: 'group', 'aria-label': '问题与回答' },
    element('span', { className: 'codex-question-reply-header' }, `问题与回答 · ${rows.length} 项`),
    ...rows.map((row, index) => {
      const answers = row.answers.filter(answer => answer.trim() !== '');
      return element('span', { key: index, className: 'codex-question-reply-item', role: 'group', 'aria-label': `问题 ${index + 1}` },
        element('span', { className: 'codex-question-reply-label' }, `问题 ${index + 1}`),
        element('strong', { className: 'codex-question-reply-question' }, row.question),
        element('span', { className: 'codex-question-reply-label' }, '回答'),
        answers.length === 0 ? element('span', { className: 'codex-question-reply-empty' }, '未填写')
          : element('span', { className: 'codex-question-reply-answers', role: 'list' },
            ...answers.map((answer, answerIndex) => element('span', { key: answerIndex, className: 'codex-question-reply-answer', role: 'listitem' }, answer))));
    }),
    element('button', { type: 'button', className: 'codex-question-reply-original', 'aria-expanded': expanded,
      onClick: () => setExpanded(value => !value) }, expanded ? '收起原始消息' : '查看原始消息'),
    expanded && element('span', { className: 'codex-question-reply-raw', role: 'region', 'aria-label': '原始问答消息', tabIndex: 0 }, raw));
}

const QUESTION_REPLY_CSS = `
.codex-question-reply{display:block;margin:6px 0;border:1px solid #7e91c536;border-radius:12px;overflow:hidden;background:#7e91c509;font:14px/1.65 system-ui,sans-serif;white-space:normal;max-width:100%;box-sizing:border-box}
.codex-question-reply-header{display:block;padding:11px 15px;border-bottom:1px solid #7e91c526;font-size:13px;font-weight:600;color:var(--ds-color-text-secondary,#5d6781)}
.codex-question-reply-item{display:block;padding:14px 15px;border-bottom:1px solid #7e91c520;overflow-wrap:anywhere}
.codex-question-reply-label{display:block;font-size:11px;letter-spacing:.03em;color:var(--ds-color-text-tertiary,#7b8391);margin-bottom:4px}
.codex-question-reply-question{display:block;font-weight:550;white-space:pre-wrap;margin-bottom:10px;color:inherit}
.codex-question-reply-answers{display:block}.codex-question-reply-answer{display:block;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 11px;background:#5f976a12;border-left:3px solid #6f9f7b;border-radius:4px;margin:4px 0;color:inherit}
.codex-question-reply-empty{display:block;color:#7b8391;font-style:italic}.codex-question-reply-original{display:inline-block;border:0;background:none;color:var(--ds-color-text-tertiary,#737e94);font:inherit;font-size:12px;cursor:pointer;padding:10px 15px}
.codex-question-reply-raw{display:block;border-top:1px solid #7e91c526;padding:12px 15px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:300px;user-select:text;font:12px/1.6 ui-monospace,monospace}
`;


function longMessagePreview(text) {
  if (text.length <= 1200 && text.split('\n').length <= 18) return undefined;
  const lines = text.split('\n');
  let preview = lines.slice(0, 12).join('\n').slice(0, 900);
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return { preview, total: text.length, lines: lines.length };
}

/** Decorate only native plain user-text nodes; references, Q&A and attachments keep their renderers. */
function LongUserText({ node, raw, nativeText, ...props }) {
  const [expanded, setExpanded] = React.useState(false);
  const [size, setSize] = React.useState(14);
  const text = node.data.display ?? node.data.text ?? raw ?? '';
  const limit = longMessagePreview(text);
  const render = value => nativeText
    ? React.createElement(nativeText, { ...props, raw, node: { ...node, data: { ...node.data, display: value } } })
    : React.createElement('span', { style: { whiteSpace: 'pre-wrap' } }, value);
  if (!limit) return render(text);
  return React.createElement('span', { className: 'codex-long-message', 'aria-label': '长消息内容' },
    React.createElement('span', { className: expanded ? 'codex-long-message-body expanded' : 'codex-long-message-body', style: { fontSize: size }, tabIndex: expanded ? 0 : undefined }, render(expanded ? text : limit.preview + '…')),
    React.createElement('span', { className: 'codex-long-message-actions' },
      React.createElement('button', { type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, expanded ? '收起内容' : `展开全部（${limit.total} 字符 / ${limit.lines} 行）`),
      expanded && React.createElement(React.Fragment, null,
        React.createElement('button', { type: 'button', 'aria-label': '缩小消息字号', disabled: size <= 12, onClick: () => setSize(value => Math.max(12, value - 2)) }, 'A−'),
        React.createElement('button', { type: 'button', 'aria-label': '放大消息字号', disabled: size >= 24, onClick: () => setSize(value => Math.min(24, value + 2)) }, 'A＋'),
        React.createElement('small', null, '可拖动右下角调整高度'))));
}
const LONG_MESSAGE_CSS = `
.codex-long-message{display:block;max-width:100%;white-space:normal}.codex-long-message-body{display:block;overflow-wrap:anywhere}.codex-long-message-body.expanded{max-height:65vh;min-height:140px;overflow:auto;resize:vertical;padding:8px 0;white-space:pre-wrap}.codex-long-message-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:8px;color:#747d8f;font:12px/1.5 system-ui}.codex-long-message-actions button{background:none;border:1px solid #8a93a535;border-radius:6px;color:inherit;cursor:pointer;font:inherit;padding:4px 9px}.codex-long-message-actions button:disabled{opacity:.4;cursor:default}
`;
function installLongMessages(ctx) {
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'text', priority: 0,
    inject: () => ({ nativeText: ctx.slots.entries?.('conversation.user.text.node').find(entry => entry.options.key === 'text' && entry.component !== LongUserText)?.component }),
  }, LongUserText));
}

const sh = React.createElement;

/** Hide only proved imported members; keep unrelated and mixed workspaces intact. */
function ordinarySidebar(workspaces, sessions, imported) {
  const ids = new Set(imported.map(row => row.id));
  const groups = workspaces.flatMap(workspace => {
    const members = workspace.sessionIds.filter(id => !ids.has(id));
    if (!members.length && workspace.sessionIds.some(id => ids.has(id))) return [];
    return [{ ...workspace, sessionIds: members }];
  });
  const accounted = new Set(workspaces.flatMap(w => w.sessionIds));
  const loose = sessions.ids.filter(id => !ids.has(id) && !accounted.has(id));
  return { groups, loose };
}

function CodexSidebar({ wide = true, expandSidebar, loadCatalog, sessionSource, workspaceSource,
  refreshSessions, openSession, openImport, nativeSidebar, revision, filterCatalog, catalogProjects }) {
  const sessionBinding = React.useMemo(() => ({ subscribe: listener => sessionSource.subscribe(listener), getSnapshot: () => sessionSource.getSnapshot() }), [sessionSource]);
  const workspaceBinding = React.useMemo(() => ({ subscribe: listener => workspaceSource.subscribe(listener), getSnapshot: () => workspaceSource.getSnapshot() }), [workspaceSource]);
  const sessions = React.useSyncExternalStore(sessionBinding.subscribe, sessionBinding.getSnapshot);
  const workspaces = React.useSyncExternalStore(workspaceBinding.subscribe, workspaceBinding.getSnapshot);
  const generation = React.useSyncExternalStore(revision.subscribe, revision.getSnapshot);
  const [catalog, setCatalog] = React.useState({ items: [], loading: true, total: 0, processed: 0, errors: [] });
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState(''); const [archive, setArchive] = React.useState('all');
  const [rootOpen, setRootOpen] = React.useState(true);
  const [expanded, setExpanded] = React.useState(new Set()); const [limits, setLimits] = React.useState({});
  React.useEffect(() => {
    const control = new AbortController(); let timer;
    const read = async (force = false) => {
      try {
        const state = await loadCatalog(control.signal, force);
        if (control.signal.aborted) return;
        setCatalog(state); setError('');
        if (state.loading) timer = setTimeout(() => read(), 1000);
        else await refreshSessions();
      } catch (reason) { if (!control.signal.aborted) setError(reason.message); }
    };
    void read(generation > 0);
    return () => { control.abort(); clearTimeout(timer); };
  }, [loadCatalog, refreshSessions, generation]);
  const imported = React.useMemo(() => filterCatalog(catalog.items, { query, archive }), [catalog.items, query, archive, filterCatalog]);
  const projects = React.useMemo(() => catalogProjects(imported), [imported, catalogProjects]);
  const normal = React.useMemo(() => ordinarySidebar(workspaces.items, sessions, catalog.items), [workspaces.items, sessions, catalog.items]);
  const current = sessions.ids.find(id => sessions.byId[id]?.retainedBy?.mainView > 0);
  const archived = new Set(workspaces.archivedSessionIds);
  const open = id => Promise.resolve(openSession(id)).catch(reason => setError(reason.message));
  const toggle = key => setExpanded(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  if (!wide) return sh('button', { type: 'button', onClick: expandSidebar, 'aria-label': '展开 Codex 导入目录' }, '▤');
  const importedRow = row => sh('button', { type: 'button', key: row.id, className: `codex-sidebar-session${current === row.id ? ' is-current' : ''}`,
    title: `${row.title}\n原项目：${row.originalCwd || row.projectPath}\n${row.sourceKind === 'chatgpt' ? 'ChatGPT' : 'Codex'} ID：${row.threadId}`, onClick: () => open(row.id) },
  sh('span', null, row.title), row.archived && sh('small', null, '已归档'), row.metadataOnly && sh('small', null, '仅索引'));
  const normalRows = ids => ids.flatMap(id => {
    const row = sessions.byId[id];
    if (!row || (row.blank && id !== current) || archived.has(id)) return [];
    const title = row.displayTitle || '新会话';
    if (query && !title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return [];
    return [sh('button', { type: 'button', key: id, className: `codex-sidebar-session${id === current ? ' is-current' : ''}`, title, onClick: () => open(id) }, title)];
  });
  return sh('section', { className: 'codex-sidebar', 'aria-label': '工作区与 Codex 导入目录' },
    sh('div', { className: 'codex-sidebar-header' }, sh('strong', null, '工作区'),
      openImport && sh('button', { type: 'button', onClick: openImport, title: '选择 Codex 或 ChatGPT 来源并预览' }, '导入对话'),
      sh('button', { type: 'button', onClick: () => revision.refresh(), title: '刷新导入目录和会话列表' }, '刷新'),
      sh('button', { type: 'button', onClick: nativeSidebar, title: '切换到 Harness 原生侧栏，使用工作区管理功能' }, '原生侧栏')),
    sh('input', { type: 'search', value: query, onChange: e => setQuery(e.target.value), placeholder: '搜索对话或项目', 'aria-label': '搜索侧栏全部对话与项目' }),
    sh('div', { className: 'codex-sidebar-body' },
      sh('button', { type: 'button', className: 'codex-sidebar-folder codex-sidebar-root', onClick: () => setRootOpen(!rootOpen), 'aria-expanded': rootOpen || !!query },
        `${rootOpen || query ? '▾' : '▸'} 📁 ${catalog.items.some(row => row.sourceKind === 'chatgpt') ? 'Codex / ChatGPT' : 'Codex'} 导入目录`, sh('small', null, catalog.loading && !catalog.items.length ? '读取中' : imported.length)),
      (rootOpen || !!query) && sh('div', { className: 'codex-sidebar-imports', 'aria-label': 'Codex 导入项目列表' },
        sh('select', { value: archive, onChange: e => setArchive(e.target.value), 'aria-label': '侧栏导入归档筛选' },
          sh('option', { value: 'all' }, '全部导入对话'), sh('option', { value: 'active' }, '未归档'), sh('option', { value: 'archived' }, '已归档')),
        catalog.loading && sh('small', { role: 'status' }, `正在读取 ${catalog.processed} / ${catalog.total}，已找到 ${catalog.items.length} 条`),
        error && sh('p', { role: 'alert' }, `读取失败：${error}。点击刷新可重试。`),
        catalog.errors?.length > 0 && sh('small', { role: 'alert' }, `${catalog.errors.length} 条记录读取异常，可在导入总目录查看诊断。`),
        !catalog.loading && imported.length === 0 && sh('p', null, query ? '没有匹配的对话' : '暂无可显示的导入记录'),
        ...projects.map(project => {
          const rows = imported.filter(row => row.projectKey === project.key);
          const visible = expanded.has(project.key) || !!query;
          const limit = limits[project.key] || 20;
          return sh('div', { key: project.key, className: 'codex-sidebar-project' },
            sh('button', { type: 'button', className: 'codex-sidebar-folder', title: project.path || '未关联项目', 'aria-expanded': visible, onClick: () => toggle(project.key) },
              sh('span', null, `${visible ? '▾' : '▸'} ${project.title}`), sh('small', null, project.count)),
            visible && sh('div', { 'aria-label': `${project.title} 的导入对话` }, ...rows.slice(0, limit).map(importedRow),
              rows.length > limit && sh('button', { type: 'button', className: 'codex-sidebar-more', onClick: () => setLimits(old => ({ ...old, [project.key]: limit + 50 })) }, `展开其余 ${rows.length - limit} 条对话`)));
        })),
      ...(catalog.loading && !catalog.items.length ? [] : normal.groups).map(group => sh('div', { key: group.workspaceId },
        sh('button', { type: 'button', className: 'codex-sidebar-folder', title: group.path, onClick: () => toggle(group.workspaceId), 'aria-expanded': expanded.has(group.workspaceId) },
          `${expanded.has(group.workspaceId) ? '▾' : '▸'} ${group.title || '默认工作区'}`),
        expanded.has(group.workspaceId) && normalRows(group.sessionIds))),
      (!catalog.loading || catalog.items.length > 0) && normal.loose.length > 0 && sh('div', { 'aria-label': '未分组会话' }, sh('strong', null, '未分组'), ...normalRows(normal.loose))));
}

const CODEX_SIDEBAR_CSS = `
.codex-sidebar{height:100%;min-height:0;display:flex;flex-direction:column;font:13px/1.6 system-ui;color:inherit}.codex-sidebar-header{display:flex;align-items:center;gap:8px;padding:10px 16px}.codex-sidebar-header strong{margin-right:auto;font-weight:500}.codex-sidebar-header button{font:11px system-ui;color:#6b7380;background:none;border:0;cursor:pointer}.codex-sidebar>input{margin:0 14px 10px;padding:8px 10px;min-width:0;border:1px solid #8c95a52b;border-radius:8px;background:transparent;color:inherit;font:inherit}.codex-sidebar-body{min-height:0;flex:1;overflow:auto;padding:0 10px 18px}.codex-sidebar-folder{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;padding:9px 8px;font:inherit;cursor:pointer}.codex-sidebar-folder>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codex-sidebar-folder>small{margin-left:auto;color:#7b8290}.codex-sidebar-root{font-weight:600}.codex-sidebar-imports{padding-left:12px;border-left:1px solid #8793a429;margin-left:10px}.codex-sidebar-imports>select{max-width:100%;margin:3px 0 8px;padding:5px;border:1px solid #8793a430;border-radius:7px;background:transparent;color:inherit;font:inherit}.codex-sidebar-imports>small{display:block;color:#7b8290}.codex-sidebar-session{display:flex;gap:5px;align-items:center;text-align:left;width:100%;padding:8px 9px 8px 20px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}.codex-sidebar-session>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.codex-sidebar-session>small{color:#8d94a3;white-space:nowrap}.codex-sidebar-session:hover,.codex-sidebar-folder:hover{background:#8793a412}.codex-sidebar-session.is-current{background:#536dfe18}.codex-sidebar-more{border:0;background:transparent;padding:8px;color:#5866a5;font:inherit;cursor:pointer}
`;

/** A public single-slot contribution; native services and disk records are untouched. */
function installImportedSidebar(ctx, options) {
  if (!ctx.workspaces?.list || !ctx.sessions?.list || !ctx.slots.entries) return undefined;
  let generation = 0; const listeners = new Set();
  const revision = { getSnapshot: () => generation, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh() { generation++; for (const listener of listeners) listener(); } };
  let available = false, release;
  let enabled = true;
  try { enabled = localStorage.getItem('codex-import.native-sidebar') !== 'true'; } catch {}
  const mount = () => {
    if (!available || !enabled || release) return;
    release = ctx.slots.register({ name: 'sidebar.workspaces', priority: -20, inject: () => ({ ...options, revision,
      sessionSource: ctx.sessions.list, workspaceSource: ctx.workspaces.list,
      nativeSidebar: () => { enabled = false; try { localStorage.setItem('codex-import.native-sidebar', 'true'); } catch {} release?.(); release = undefined; },
    }) }, CodexSidebar);
  };
  ctx.slots.inject('sidebar.workspaces', () => { available = true; mount(); return () => { available = false; release?.(); release = undefined; }; });
  return { refresh: () => revision.refresh(), enable() {
    enabled = true; try { localStorage.removeItem('codex-import.native-sidebar'); } catch {} mount(); revision.refresh();
  } };
}


const h = React.createElement;
const PANEL = 'codex-import-browser';
const RECORD = 'codex-import-record';
const RECORD_MARKER = /^\[Codex (?:终端记录|文件变更|MCP|工具|搜索|查看图片|生成图片|function_call|function_call_output|custom_tool_call|custom_tool_call_output|web_search_call|local_shell_call|tool_call|tool_result|computer_call)/;

/** Match only this importer's durable messages, leaving ordinary replies alone. */
function importedRecord(event) {
  if (event.type !== 'assistant/message') return undefined;
  const message = event.data?.message;
  if (!message?.id?.startsWith('codex-message-') || !Array.isArray(message.content)
    || !message.content.length || message.content.some(block => block.type !== 'text' && !(block.type === 'image' && block.attachment))) return undefined;
  const value = message.content.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
  if (!RECORD_MARKER.test(value)) return undefined;
  const lines = value.split('\n');
  const label = lines[0].replace(/^\[Codex\s*|\]$/g, '').replace('completed', '已完成');
  const command = lines.find(line => line.startsWith('$ '))?.slice(2);
  const images = message.content.filter(block => block.type === 'image').map(block => ({ attachment: block.attachment }));
  const imageRecord = /^\[Codex (?:查看图片|生成图片)/.test(value) || images.length > 0;
  const displayName = imageRecord ? images.map(image => image.attachment.name).filter(Boolean).join('、')
    || lines.find(line => line.trim().startsWith('/'))?.trim().split(/[\\/]/).at(-1) || '' : '';
  return { label, command, text: value, lines: lines.length, time: event.time, images, imageRecord, displayName };
}

/** Exclusively claim imported tool-text messages in the Chat target, without altering logs. */
const recordDefinition = {
  kind: RECORD, target: 'chat',
  match: { 'assistant/message': event => importedRecord(event) ? { id: String(event.seq), role: 'start', exclusive: true } : null },
  start: (_context, match) => importedRecord(match.event),
  update: context => context.state,
  buildViewNode(context) {
    const start = context.start || context.matches[0];
    const data = context.state || (start && importedRecord(start.event));
    if (!start || !data) return null;
    return { key: context.key, id: context.id, kind: RECORD, target: 'chat', anchorSeq: start.event.seq,
      location: start.location, groupTree: 'turn', visibility: 'visible', data };
  },
};

function ImportedRecordCard({ node, useDisclosure, renderFactorySlot, loadImage }) {
  const { expanded, toggle } = useDisclosure();
  const data = node.data;
  return h('section', { className: 'codex-record', 'aria-label': `Codex ${data.label}` },
    h('button', { className: 'codex-record-heading', type: 'button', onClick: toggle, 'aria-expanded': expanded },
      h('span', { 'aria-hidden': true }, expanded ? '▾' : '▸'),
      h('strong', null, data.label),
      data.displayName && h('span', { className: 'codex-record-filename', title: data.displayName }, data.displayName),
      h('span', { className: 'codex-muted' }, data.imageRecord ? data.images.length ? `${data.images.length} 张图片` : '图片记录' : `${data.lines} 行`),
      h('span', { className: 'codex-record-action' }, data.imageRecord ? expanded ? '收起详情' : '展开详情' : expanded ? '收起记录' : '展开记录')),
    !data.imageRecord && data.command && h('div', { className: 'codex-record-command', title: data.command }, '$ ' + data.command),
    data.images.length > 0 && h('div', { className: 'codex-record-images' }, renderFactorySlot('conversation.images.content', {
      images: data.images, loadImage, align: 'start', compact: data.images.length > 1,
    })),
    expanded && h('pre', { className: 'codex-record-output', tabIndex: 0 }, data.text));
}

const importedFilesDefinition = {
  kind: 'codex-import-files', target: 'chat',
  match: { 'codex-import/files': event => ({ id: String(event.seq), role: 'start', exclusive: true }) },
  start: (_context, match) => match.event.data,
  update: context => context.state,
  buildViewNode(context) {
    const start = context.start || context.matches[0];
    if (!start) return null;
    return { key: context.key, id: context.id, kind: 'codex-import-files', target: 'chat', anchorSeq: start.event.seq,
      location: start.location, groupTree: 'turn', visibility: 'visible', data: context.state || start.event.data };
  },
};

/** Generated downloads keep their native immutable file reference and copied path. */
function ImportedFilesCard({ node, openFile }) {
  return h('section', { className: 'codex-import-files', 'aria-label': 'Codex 导入文件附件' },
    ...node.data.files.map((file, index) => h('button', { key: index, type: 'button', className: 'codex-button', disabled: !file.hostPath,
      onClick: () => openFile(file.hostPath), title: file.attachment.name },
      `▤ ${file.attachment.name} · ${(file.attachment.bytes / 1024).toFixed(1)} KB · 打开附件`)));
}

function filterCatalog(items, { query = '', project = '', archive = 'all' } = {}) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(row => (!project || row.projectKey === project)
    && (archive === 'all' || (archive === 'archived' ? row.archived : !row.archived))
    && words.every(word => `${row.title}\n${row.projectTitle}\n${row.projectPath}\n${row.originalCwd}\n${row.threadId}`.toLocaleLowerCase().includes(word)));
}

function catalogProjects(items) {
  const groups = new Map();
  for (const row of items) {
    const group = groups.get(row.projectKey) || { key: row.projectKey, title: row.projectTitle, path: row.projectPath, count: 0 };
    group.count++; groups.set(group.key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

function ImportBrowser({ loadCatalog, openSession, refreshSessions, enableSidebar, openImport }) {
  const [state, setState] = React.useState({ items: [], loading: true, total: 0, processed: 0, errors: [] });
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [project, setProject] = React.useState('');
  const [archive, setArchive] = React.useState('all');
  const [limit, setLimit] = React.useState(100);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    const control = new AbortController(); let timer;
    const read = async (refresh = false) => {
      try {
        const next = await loadCatalog(control.signal, refresh);
        if (control.signal.aborted) return;
        setState(next); setError('');
        if (next.loading) timer = setTimeout(() => read(), 1000);
        else await refreshSessions();
      } catch (reason) { if (!control.signal.aborted) setError(reason.message); }
    };
    void read(generation > 0);
    return () => { control.abort(); clearTimeout(timer); };
  }, [loadCatalog, refreshSessions, generation]);
  React.useEffect(() => { setLimit(100); }, [query, project, archive]);
  const filtered = React.useMemo(() => filterCatalog(state.items, { query, project, archive }), [state.items, query, project, archive]);
  const projects = React.useMemo(() => catalogProjects(state.items), [state.items]);
  const chosen = projects.find(group => group.key === project);
  const selectProject = key => { setProject(key); setLimit(100); };
  return h('main', { className: 'codex-browser', 'aria-label': 'Codex 导入项目与对话' },
    h('header', { className: 'codex-browser-header' },
      h('div', null, h('h1', null, state.items.some(row => row.sourceKind === 'chatgpt') ? 'Codex / ChatGPT 导入目录' : 'Codex 导入目录'), h('p', { className: 'codex-muted' }, `按来源与项目浏览 · ${projects.length} 个分组 · ${state.items.length} 条会话`)),
      openImport && h('button', { type: 'button', className: 'codex-button', onClick: openImport }, '导入对话'),
      enableSidebar && h('button', { type: 'button', className: 'codex-button', onClick: enableSidebar }, '使用导入目录侧栏'),
      h('button', { type: 'button', className: 'codex-button', onClick: () => { setState(old => ({ ...old, loading: true })); setGeneration(value => value + 1); } }, '刷新目录')),
    h('div', { className: 'codex-browser-search' },
      h('input', { type: 'search', value: query, placeholder: '搜索全部对话标题、项目名称或路径', 'aria-label': '搜索导入对话', onChange: event => setQuery(event.target.value) }),
      h('select', { value: archive, 'aria-label': '归档筛选', onChange: event => setArchive(event.target.value) },
        h('option', { value: 'all' }, '全部对话'), h('option', { value: 'active' }, '未归档'), h('option', { value: 'archived' }, '已归档'))),
    state.loading && h('p', { role: 'status', className: 'codex-browser-status' }, `正在整理项目与标题 ${state.processed} / ${state.total || '…'}，无需逐条点开会话。`),
    error && h('p', { role: 'alert', className: 'codex-browser-error' }, error),
    state.errors?.length > 0 && h('p', { className: 'codex-muted' }, `${state.errors.length} 条记录暂时无法读取，其原内容保留。`),
    h('div', { className: 'codex-browser-columns' },
      h('nav', { className: 'codex-projects', 'aria-label': '原始 Codex 项目' },
        h('button', { type: 'button', className: !project ? 'is-selected' : '', onClick: () => selectProject('') }, '全部项目', h('span', null, state.items.length)),
        ...projects.map(group => h('button', { type: 'button', key: group.key, title: group.path,
          className: project === group.key ? 'is-selected' : '', onClick: () => selectProject(group.key) },
          h('div', null, h('strong', null, group.title), h('small', null, group.path || '没有原项目路径')), h('span', null, group.count)))),
      h('section', { className: 'codex-catalog-results', 'aria-label': '导入对话列表' },
        h('h2', null, chosen?.title || '全部项目', h('span', { className: 'codex-muted' }, ` · ${filtered.length} 条`)),
        chosen?.path && h('p', { className: 'codex-muted codex-project-path' }, chosen.path),
        !state.loading && !filtered.length && h('p', { className: 'codex-muted' }, query ? '没有匹配的对话。可切换到全部项目继续搜索。' : '此范围内没有已导入的对话。'),
        ...filtered.slice(0, limit).map(row => h('button', { type: 'button', key: row.id, className: 'codex-catalog-row',
          onClick: () => openSession(row.id), title: row.title },
          h('strong', null, row.title),
          h('span', { className: 'codex-muted' }, `${row.projectTitle} · ${new Date(row.updatedAt).toLocaleDateString('zh-CN')}${row.archived ? ' · 已归档' : ''}${row.metadataOnly ? ' · 仅索引' : ''}${row.attachmentImages || row.attachmentFiles ? ` · 图片 ${row.attachmentImages || 0} / 文件 ${row.attachmentFiles || 0}` : ''}${row.attachmentMissing ? ` · 附件缺失 ${row.attachmentMissing}` : ''}`),
          h('small', { className: 'codex-muted' }, row.originalCwd || '未关联项目'))),
        filtered.length > limit && h('button', { className: 'codex-button', type: 'button', onClick: () => setLimit(value => value + 100) }, `继续显示（还有 ${filtered.length - limit} 条）`))));
}

const PRESENTATION_CSS = `
.codex-browser{height:100%;box-sizing:border-box;overflow:auto;padding:30px 36px;color:var(--ds-color-text-primary,#24272e);background:var(--ds-color-bg-base,#fff);font:14px/1.6 system-ui,sans-serif}
.codex-browser h1{font-size:26px;margin:0}.codex-browser h2{font-size:17px;margin:0 0 14px}.codex-browser p{margin:6px 0 14px}.codex-muted{color:var(--ds-color-text-tertiary,#727886)}
.codex-browser-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.codex-button{border:1px solid #dce0e7;background:transparent;color:inherit;padding:8px 16px;border-radius:8px;cursor:pointer;font:inherit;white-space:nowrap}
.codex-browser-search{display:flex;gap:12px;margin-bottom:22px}.codex-browser-search input{flex:1;min-width:0}.codex-browser-search input,.codex-browser-search select{padding:11px 14px;border:1px solid #dce0e7;border-radius:9px;font:inherit;color:inherit;background:transparent}
.codex-browser-columns{display:grid;grid-template-columns:minmax(180px,250px) minmax(0,1fr);gap:28px}.codex-projects{align-self:start;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;max-height:70vh;overflow:auto}.codex-projects button{display:flex;justify-content:space-between;align-items:center;text-align:left;gap:12px;border:0;background:transparent;color:inherit;padding:11px 12px;border-radius:9px;cursor:pointer;font:inherit;flex:none}.codex-projects button:hover,.codex-catalog-row:hover{background:#72788612}.codex-projects button.is-selected{background:#536dfe14;color:#3958cd}.codex-projects strong{font-weight:600}.codex-projects small{display:block;max-width:185px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7b8290;font-size:11px}.codex-projects span{font-size:12px;color:#7b8290}.codex-project-path{overflow-wrap:anywhere}
.codex-catalog-row{display:flex;flex-direction:column;align-items:flex-start;gap:5px;border:1px solid #929baa24;border-radius:11px;background:transparent;color:inherit;cursor:pointer;padding:16px 18px;margin:0 0 10px;width:100%;text-align:left;font:inherit}.codex-catalog-row strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15px;font-weight:550;white-space:normal;overflow-wrap:anywhere}.codex-catalog-row small{font-size:11px;overflow-wrap:anywhere}.codex-catalog-row span{font-size:12px}.codex-browser-status{color:#3958cd}.codex-browser-error{color:#ba3026}
.codex-record{border:1px solid #929baa30;border-radius:10px;margin:10px 0;overflow:hidden;font:13px/1.6 system-ui,sans-serif}.codex-record-heading{display:flex;align-items:center;gap:9px;width:100%;border:0;padding:10px 14px;background:#929baa09;color:inherit;text-align:left;font:inherit;cursor:pointer}.codex-record-heading strong{font-weight:550}.codex-record-action{margin-left:auto;color:#727886;font-size:12px;white-space:nowrap}.codex-record-command{padding:0 14px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.7 ui-monospace,monospace;color:#727886}.codex-record-output{margin:0;border-top:1px solid #929baa20;padding:14px;max-height:460px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;background:#929baa08;user-select:text}
.codex-import-files{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.codex-import-files button{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.codex-record-filename{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#727886}.codex-record-heading strong{flex-shrink:0}.codex-record-images{padding:0 14px 14px}.codex-record-heading>.codex-muted{white-space:nowrap;font-size:12px}
@media(max-width:760px){.codex-browser{padding:20px 16px}.codex-browser-columns{grid-template-columns:minmax(130px,170px) minmax(0,1fr);gap:14px}.codex-projects small{max-width:120px}.codex-browser-search{flex-wrap:wrap}}
`;

/** All UI extensions use Harness's registered slots and Conversation Definitions. */
function installPresentation(ctx, { openImport } = {}) {
  installLongMessages(ctx);
  const style = document.createElement('style'); style.textContent = PRESENTATION_CSS + QUESTION_REPLY_CSS + CODEX_SIDEBAR_CSS + LONG_MESSAGE_CSS;
  document.head.append(style); ctx.effect(() => () => style.remove());
  ctx.effect(() => ctx.uiConversation.userText.register(questionReplyRule));
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: questionReplyRule.id }, QuestionReplyView));
  ctx.effect(() => ctx.uiConversation.events.register(recordDefinition));
  ctx.effect(() => ctx.uiConversation.events.register(importedFilesDefinition));
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: RECORD }, ImportedRecordCard));
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'codex-import-files' }, ImportedFilesCard));
  const loadCatalog = async (signal, refresh) => {
    const response = await fetch('/api/codex-import/catalog' + (refresh ? '?refresh=1' : ''), { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`目录读取失败（${response.status}）`);
    return response.json();
  };
  const refreshSessions = () => ctx.sessions?.refresh?.();
  const sidebar = installImportedSidebar(ctx, { loadCatalog, refreshSessions, openImport, openSession: id => ctx.uiWorkspace.openSession(id), filterCatalog, catalogProjects });
  // Also refresh the existing native sidebar after the startup cache warmup.
  if (ctx.sessions) ctx.effect(() => {
    const control = new AbortController(); let timer;
    const refreshWhenReady = async () => {
      try {
        const state = await loadCatalog(control.signal, false);
        if (control.signal.aborted) return;
        if (state.loading) timer = setTimeout(refreshWhenReady, 1000);
        else await refreshSessions();
      } catch { /* The browser panel exposes catalog failures with a retry action. */ }
    };
    void refreshWhenReady();
    return () => { control.abort(); clearTimeout(timer); };
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
    inject: () => ({ loadCatalog, refreshSessions, openImport, openSession: id => ctx.uiWorkspace.openSession(id), enableSidebar: sidebar?.enable }),
  }, ImportBrowser));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 20, label: 'Codex 导入目录',
  }, ({ size = 20 }) => h('span', { style: { fontSize: size, lineHeight: 1 }, 'aria-hidden': true }, '▤')));
  return { async refresh() { await refreshSessions(); sidebar?.refresh(); } };
}

/** Compact attachment totals for the main progress and confirmation views. */
function attachmentSummaryText(audit, fallback) {
  if (!audit) return `附件引用：图片 ${fallback?.attachmentImages || 0} · 文件 ${fallback?.attachmentFiles || 0} · 不可导入 ${fallback?.attachmentMissing || 0}`;
  const format = row => `${row.unique} 项 / ${row.references} 次引用`;
  return `可恢复：图片 ${format(audit.available.images)}，文件 ${format(audit.available.files)}\n不可导入：图片 ${format(audit.missing.images)}，文件 ${format(audit.missing.files)}` + (audit.reference?.files.references ? `\n代码位置引用（不计入附件）：${format(audit.reference.files)}` : '');
}

/** Full paginated records are fetched on demand, never embedded in job logs. */
function createAttachmentDetails(button) {
  const make = (tag, label, text) => {
    const node = document.createElement(tag);
    if (label) node.setAttribute('aria-label', label);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const popup = make('dialog', '附件统计与明细');
  popup.style.cssText = 'width:min(950px,92vw);max-height:85vh;overflow:auto;padding:24px;border:1px solid #ddd;border-radius:16px;background:#fff;color:#1d2433;font:14px/1.65 system-ui;box-shadow:0 20px 80px #0003;';
  const heading = make('h2', '', '附件统计与明细'); heading.style.margin = '0 0 10px';
  const explanation = make('p', '', '项数为去重数量，引用次数保留重复引用。本地附件按规范化来源路径去重；内嵌图片按内容摘要去重。同名不同目录分别计算，不按文件内容合并。各结果、原因分组独立去重，同一来源可能出现在不同分组。带行号的代码跳转链接单独统计，不计入附件失败；无法确定来源的引用独立计数。');
  const totals = make('div', '附件分类统计');
  const reasons = make('details', '按缺失原因统计');
  reasons.append(make('summary', '', '按缺失原因查看统计（去重项数 / 引用次数）'));
  const reasonTable = make('div'); reasons.append(reasonTable);
  const filters = make('div'); filters.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;';
  const select = (label, options) => {
    const node = make('select', label);
    for (const [value, text] of options) { const option = make('option', '', text); option.value = value; node.append(option); }
    node.value = options[0][0]; return node;
  };
  const type = select('附件类型', [['', '全部类型'], ['image', '图片'], ['file', '文件']]);
  const status = select('附件恢复状态', [['missing', '不可导入'], ['available', '可恢复'], ['reference', '代码位置引用（不计入附件）'], ['all', '全部状态']]);
  const reason = select('附件缺失原因', [['', '全部缺失原因']]);
  const search = make('input', '搜索附件明细'); search.type = 'search'; search.placeholder = '文件名、路径、对话标题或 ID'; search.style.flex = '1';
  const refresh = make('button', '', '刷新明细'); refresh.type = 'button';
  filters.append(type, status, reason, search, refresh);
  for (const node of [type, status, reason, search, refresh]) node.style.cssText += ';padding:7px 10px;border:1px solid #ddd;border-radius:7px;font:inherit;';
  const info = make('p', '附件明细状态'); info.setAttribute('aria-live', 'polite');
  const rows = make('div', '附件明细列表');
  const actions = make('div'); actions.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:16px;';
  const previous = make('button', '', '上一页'); const next = make('button', '', '下一页');
  const pageLabel = make('span', '附件明细页码');
  const close = make('button', '', '返回预览');
  for (const node of [previous, next, close]) { node.type = 'button'; node.style.cssText = 'padding:7px 16px;border:1px solid #ddd;border-radius:7px;background:#fff;font:inherit;cursor:pointer;'; }
  actions.append(previous, pageLabel, next, close);
  popup.append(heading, explanation, totals, reasons, filters, info, rows, actions); document.body.append(popup);
  let audit, controller, debounce, page = 1, pages = 1, sequence = 0, disposed = false;
  const table = (container, headers, values) => {
    const node = make('table'); node.style.cssText = 'border-collapse:collapse;width:100%;margin:8px 0;text-align:left;';
    const header = make('tr');
    for (const value of headers) { const cell = make('th', '', value); cell.style.cssText = 'padding:6px;border-bottom:1px solid #ddd;'; header.append(cell); }
    node.append(header);
    for (const row of values) {
      const line = make('tr');
      for (const value of row) { const cell = make('td', '', String(value)); cell.style.cssText = 'padding:6px;border-bottom:1px solid #eee;'; line.append(cell); }
      node.append(line);
    }
    container.replaceChildren(node);
  };
  const countsText = row => `${row.unique} / ${row.references}`;
  const showStats = data => {
    table(totals, ['类型', '可恢复（项 / 次）', '不可导入（项 / 次）', '代码引用（排除）'], [
      ['图片', countsText(data.available.images), countsText(data.missing.images), '—'],
      ['文件', countsText(data.available.files), countsText(data.missing.files), data.reference ? countsText(data.reference.files) : '0 / 0'],
    ]);
    table(reasonTable, ['缺失原因', '图片（项 / 次）', '文件（项 / 次）'], data.reasons.map(row => [row.label, countsText(row.images), countsText(row.files)]));
    const selected = reason.value;
    reason.replaceChildren();
    for (const [value, text] of [['', '全部缺失原因'], ...data.reasons.map(row => [row.code, row.label])]) {
      const option = make('option', '', text); option.value = value; reason.append(option);
    }
    reason.value = data.reasons.some(row => row.code === selected) ? selected : '';
  };
  const load = async () => {
    if (!audit || disposed) return;
    const id = audit.id; const request = ++sequence;
    controller?.abort(); controller = new AbortController();
    info.textContent = '正在读取明细…'; previous.disabled = true; next.disabled = true;
    const params = new URLSearchParams({ id, type: type.value, status: status.value, reason: reason.value, q: search.value || '', page: String(page) });
    try {
      const response = await fetch(`/api/codex-import/attachments?${params}`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (disposed || request !== sequence || id !== audit?.id) return;
      if (!response.ok) throw new Error(data.error || '附件明细读取失败');
      showStats(data.audit); page = data.page; pages = data.pages;
      info.textContent = `${data.audit.complete ? '扫描已完成' : '扫描尚未完成，可刷新查看新增结果'} · 匹配 ${data.total} 项（按来源、类型、恢复状态和原因分组）`;
      rows.replaceChildren();
      for (const row of data.rows) {
        const item = make('details'); item.style.cssText = 'border:1px solid #e4e5eb;border-radius:9px;padding:10px;margin:8px 0;overflow-wrap:anywhere;';
        item.append(make('summary', '', `${row.type === 'image' ? '图片' : '文件'} · ${row.name} · ${row.reason || '可恢复'} · 引用 ${row.references} 次 · ${row.conversations.length} 条对话`));
        const body = make('div'); body.style.cssText = 'white-space:pre-wrap;user-select:text;margin-top:8px;';
        body.textContent = `来源：${row.source}\n${row.locations?.length ? `原始位置引用：\n${row.locations.join('\n')}\n` : ''}${row.reason ? `原因：${row.reason}\n详细说明：${row.detail}\n` : ''}关联对话：\n` + row.conversations.map(c => `${c.title}\nCodex ID：${c.id}\n原项目：${c.project || '无'}\n引用 ${c.references} 次；消息标识：${c.messages.join('、')}`).join('\n\n');
        item.append(body); rows.append(item);
      }
      if (!data.rows.length) rows.append(make('p', '', '没有符合筛选条件的附件。'));
      pageLabel.textContent = `${page} / ${pages}`; previous.disabled = page <= 1; next.disabled = page >= pages;
    } catch (error) {
      if (error.name !== 'AbortError' && request === sequence && !disposed) { rows.replaceChildren(); info.textContent = `${error.message} 可返回后重新执行 /codex-import preview。`; }
    }
  };
  const filter = () => { if (['available', 'reference'].includes(status.value)) reason.value = ''; reason.disabled = ['available', 'reference'].includes(status.value); page = 1; void load(); };
  const onSearch = () => { clearTimeout(debounce); debounce = setTimeout(filter, 250); };
  const open = () => { if (!audit) return; if (!popup.open) popup.showModal(); showStats(audit); void load(); };
  const back = () => { sequence++; controller?.abort(); clearTimeout(debounce); popup.close(); button.focus(); };
  const onPrevious = () => { if (page > 1) { page--; void load(); } };
  const onNext = () => { if (page < pages) { page++; void load(); } };
  button.addEventListener('click', open); close.addEventListener('click', back);
  for (const node of [type, status, reason]) node.addEventListener('change', filter);
  search.addEventListener('input', onSearch); refresh.addEventListener('click', filter);
  previous.addEventListener('click', onPrevious); next.addEventListener('click', onNext);
  button.hidden = true;
  return {
    update(value) {
      if (audit?.id !== value?.id) { sequence++; controller?.abort(); page = 1; type.value = ''; status.value = 'missing'; reason.value = ''; search.value = ''; }
      audit = value; button.hidden = !value;
    },
    dispose() {
      disposed = true; controller?.abort(); clearTimeout(debounce);
      button.removeEventListener('click', open); close.removeEventListener('click', back);
      for (const node of [type, status, reason]) node.removeEventListener('change', filter);
      search.removeEventListener('input', onSearch); refresh.removeEventListener('click', filter);
      previous.removeEventListener('click', onPrevious); next.removeEventListener('click', onNext); popup.remove();
    },
  };
}

/** Browser-side source selection. ZIP bytes use Fetch's Blob body, never JSON/base64. */
function createImportWizard({ element, getSession, onPreview, request = (...args) => fetch(...args) }) {
  const node = element('section', '导入来源选择'); node.hidden = true;
  const intro = element('p'); intro.textContent = '选择要导入的对话来源，预览后再确认导入。';
  const tabs = element('div'); tabs.style.cssText = 'display:flex;gap:12px;margin:16px 0;';
  const codexButton = element('button', '导入本地 Codex'); codexButton.textContent = '本地 Codex';
  const chatgptButton = element('button', '导入 ChatGPT 导出包'); chatgptButton.textContent = 'ChatGPT 导出包';
  tabs.append(codexButton, chatgptButton);
  const codexArea = element('section', 'Codex 数据来源');
  const codexInfo = element('p'); codexInfo.textContent = '读取当前 dsh 实例所在机器的 Codex 数据。';
  const codexSelect = element('select', '选择 Codex 数据目录');
  codexSelect.style.cssText = 'width:100%;padding:10px;font:inherit;';
  codexArea.append(codexInfo, codexSelect);
  const zipArea = element('section', 'ChatGPT ZIP 文件');
  const drop = element('div', '拖放 ChatGPT ZIP'); drop.tabIndex = 0;
  drop.style.cssText = 'padding:28px 16px;border:2px dashed #a7a0d6;border-radius:12px;text-align:center;background:#f7f6ff;color:#393075;';
  const dropText = element('p'); dropText.textContent = '将 ChatGPT 导出的 ZIP 拖到这里';
  const choose = element('button', '选择 ZIP 文件'); choose.textContent = '选择 ZIP 文件';
  const input = element('input', 'ChatGPT ZIP 文件选择器'); input.type = 'file'; input.accept = '.zip,application/zip'; input.hidden = true;
  const zipHint = element('p'); zipHint.textContent = '无需解压。文件将传给当前连接的 dsh 实例，用于预览和导入。'; zipHint.style.fontSize = '12px';
  drop.append(dropText, choose, input, zipHint);
  const selected = element('p', '已选择的 ZIP'); selected.style.cssText = 'overflow-wrap:anywhere;';
  const change = element('button', '更换 ZIP 文件'); change.textContent = '更换文件'; change.hidden = true;
  zipArea.append(drop, selected, change);
  const advanced = element('details', '导入高级选项'); advanced.style.cssText = 'margin:18px 0;';
  const advancedTitle = element('summary'); advancedTitle.textContent = '高级选项'; advanced.append(advancedTitle);
  const checkbox = (label, checked) => {
    const row = element('label'); row.style.cssText = 'display:flex;gap:8px;margin:10px 0;';
    const control = element('input', label); control.type = 'checkbox'; control.checked = checked;
    const caption = element('span'); caption.textContent = label; row.append(control, caption); advanced.append(row); return control;
  };
  const attachments = checkbox('导入可恢复的图片和文件', true);
  const archived = checkbox('包含归档对话', true);
  const overlap = checkbox('检查与 dsh 已有会话的内容重合', true);
  const field = (label, placeholder) => {
    const row = element('label'); row.style.cssText = 'display:block;margin:12px 0;'; row.textContent = label;
    const control = element('input', label); control.type = 'text'; control.placeholder = placeholder;
    control.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:5px;font:inherit;';
    row.append(control); advanced.append(row); return control;
  };
  const customHome = field('其他 Codex 数据目录', '留空使用上面选择的目录');
  const destination = field('导入目标目录', '留空使用默认目录');
  const sourceId = field('ChatGPT 稳定来源标识', '通常留空；导出缺少账户 ID 时填写');
  const status = element('p', '文件准备状态'); status.setAttribute('aria-live', 'polite');
  const error = element('p', '导入来源错误'); error.setAttribute('role', 'alert'); error.style.color = '#b53324';
  const preparation = element('progress', '文件准备进度'); preparation.hidden = true; preparation.style.width = '100%';
  const start = element('button', '开始预览'); start.textContent = '开始预览';
  start.style.cssText = 'padding:10px 24px;border:0;border-radius:9px;background:#5146db;color:white;font:inherit;cursor:pointer;';
  for (const button of [codexButton, chatgptButton, choose, change]) {
    button.type = 'button'; button.style.cssText = 'padding:9px 16px;border:1px solid #bfb9e0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;';
  }
  start.type = 'button';
  node.append(intro, tabs, codexArea, zipArea, advanced, status, preparation, error, start);
  let source = 'codex', owner, file, staged, busy = false, loading = false, disposed = false, modified = false;
  let maxBytes = 1024 ** 3, setupController, uploadController;
  const listeners = [];
  const listen = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const setPreference = value => { try { localStorage.setItem('codex-import.source', value); } catch {} };
  const deleteStaged = async () => {
    const previous = staged; staged = undefined;
    if (previous) await request(`/api/codex-import/upload?sessionId=${encodeURIComponent(previous.owner)}&id=${encodeURIComponent(previous.id)}`, { method: 'DELETE' }).catch(() => {});
  };
  const update = () => {
    codexArea.hidden = source !== 'codex'; zipArea.hidden = source !== 'chatgpt';
    codexButton.setAttribute('aria-pressed', String(source === 'codex')); chatgptButton.setAttribute('aria-pressed', String(source === 'chatgpt'));
    customHome.parentElement && (customHome.parentElement.hidden = source !== 'codex');
    sourceId.parentElement && (sourceId.parentElement.hidden = source !== 'chatgpt');
    overlap.disabled = source !== 'chatgpt' || busy;
    for (const control of [codexButton, chatgptButton, choose, change, codexSelect, attachments, archived, customHome, destination, sourceId]) control.disabled = busy;
    start.disabled = loading || busy || (source === 'chatgpt' && !file);
    change.hidden = !file; preparation.hidden = !busy;
    selected.textContent = file ? `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB` : '';
    start.textContent = busy ? '正在准备…' : '开始预览';
  };
  const selectSource = value => {
    if (busy) return;
    source = value; modified = true; setPreference(value); error.textContent = ''; status.textContent = '';
    if (value === 'codex') void deleteStaged(); update();
  };
  const selectFile = value => {
    if (busy) return;
    error.textContent = ''; status.textContent = ''; void deleteStaged();
    if (!value || !/\.zip$/i.test(value.name)) { file = undefined; error.textContent = '请选择一个 ChatGPT 导出的 ZIP 文件。'; }
    else if (!value.size || value.size > maxBytes) { file = undefined; error.textContent = `ZIP 为空或超过 ${(maxBytes / 1024 ** 2).toFixed(0)} MB 的大小限制。`; }
    else file = value;
    update();
  };
  listen(codexButton, 'click', () => selectSource('codex'));
  listen(chatgptButton, 'click', () => selectSource('chatgpt'));
  listen(choose, 'click', () => input.click()); listen(change, 'click', () => input.click());
  listen(input, 'change', () => { if (input.files?.[0]) selectFile(input.files[0]); input.value = ''; });
  listen(drop, 'dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  listen(drop, 'drop', event => {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) { error.textContent = '每次请选择一个 ZIP 文件。'; return; }
    selectFile(files[0]);
  });
  listen(drop, 'keydown', event => { if (event.target === drop && !busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); input.click(); } });
  listen(start, 'click', async () => {
    if (start.disabled || busy) return;
    busy = true; error.textContent = ''; uploadController = new AbortController(); const signal = uploadController.signal; update();
    try {
      owner = await getSession(owner); signal.throwIfAborted();
      const options = { source, importAttachments: !!attachments.checked, includeArchived: !!archived.checked };
      if (destination.value?.trim()) options.importWorkspacePath = destination.value.trim();
      if (source === 'codex') options.codexHome = customHome.value?.trim() || codexSelect.value;
      else {
        options.checkOverlap = !!overlap.checked;
        if (sourceId.value?.trim()) options.sourceId = sourceId.value.trim();
        if (staged && (staged.owner !== owner || staged.expiresAt < Date.now())) await deleteStaged();
        if (!staged) {
          status.textContent = `正在准备 ${file.name}（${(file.size / 1024 ** 2).toFixed(1)} MB）…`;
          const response = await request(`/api/codex-import/upload?sessionId=${encodeURIComponent(owner)}&name=${encodeURIComponent(file.name)}`, {
            method: 'POST', headers: { 'content-type': 'application/zip' }, body: file, signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '文件准备失败');
          staged = { ...result, owner };
        }
        options.uploadToken = staged.id;
      }
      signal.throwIfAborted(); status.textContent = '正在开始预览…';
      await onPreview(owner, options);
    } catch (reason) {
      if (signal.aborted) await deleteStaged();
      if (!disposed && !node.hidden) error.textContent = signal.aborted ? '已取消文件准备。' : reason.message;
    } finally { busy = false; uploadController = undefined; update(); }
  });
  update();
  return { node,
    async open(sessionId) {
      owner = sessionId; node.hidden = false; error.textContent = ''; status.textContent = ''; loading = true; modified = false; update();
      setupController?.abort(); const controller = setupController = new AbortController();
      try {
        const response = await request('/api/codex-import/setup', { signal: controller.signal });
        const config = await response.json(); if (!response.ok) throw new Error(config.error || '无法读取导入来源');
        if (controller.signal.aborted || disposed) return;
        maxBytes = config.maxArchiveBytes;
        if (!modified) { try { source = localStorage.getItem('codex-import.source') || config.source; } catch { source = config.source; } }
        if (!['codex', 'chatgpt'].includes(source)) source = 'codex';
        codexSelect.textContent = '';
        for (const row of config.codexSources.length ? config.codexSources : [{ label: '默认 Codex（未检测到数据，可在高级选项指定目录）', path: config.codexHome }]) {
          const option = element('option'); option.value = row.path; option.textContent = `${row.label} · ${row.path}`; codexSelect.append(option);
        }
        codexSelect.value = config.codexHome;
        attachments.checked = config.defaults.importAttachments; archived.checked = config.defaults.includeArchived; overlap.checked = config.defaults.checkOverlap;
        destination.value = config.defaults.importWorkspacePath;
      } catch (reason) { if (!controller.signal.aborted && !disposed) error.textContent = `来源配置读取失败：${reason.message}。可关闭后重试。`; }
      finally { if (setupController === controller) { loading = false; update(); } }
    },
    hide() { node.hidden = true; },
    forgetUpload() { staged = undefined; },
    discardUpload() { void deleteStaged(); },
    cancel() { setupController?.abort(); uploadController?.abort(); void deleteStaged(); node.hidden = true; },
    dispose() { disposed = true; setupController?.abort(); uploadController?.abort(); void deleteStaged(); for (const remove of listeners) remove(); },
  };
}


const name = 'codex-import-results';
const inject = ['commandUi', 'jobs', 'remote', 'remote.commands', 'slots', 'uiConversation', 'sessions', 'workspaces', 'uiWorkspace', 'layout'];

const PHASES = { attachments: '正在复制图片与附件', discovering: '正在扫描本地会话', ready: '准备导入', reading: '读取会话', converting: '转换消息', writing: '写入 Harness', grouping: '关联工作区', processed: '继续下一条', finished: '整理结果', completed: '导入完成', cancelled: '已取消', failed: '导入未完成', 'cleanup-scanning': '核对导入副本与续聊', deleting: '删除 Harness 副本' };

/** Read the latest complete progress record from the bounded job output tail. */
function latestProgress(text) {
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
function apply(ctx) {
  let openImport;
  const presentation = installPresentation(ctx, { openImport: () => openImport?.() });
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
  const backButton = element('button', '更换来源或文件'); backButton.type = 'button'; backButton.textContent = '更换来源或文件'; backButton.hidden = true;
  backButton.style.cssText = 'margin-top:10px;padding:8px 16px;border:1px solid #d8d4f3;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;';
  const attachmentButton = element('button', '查看附件明细');
  attachmentButton.type = 'button'; attachmentButton.textContent = '查看附件统计与明细';
  attachmentButton.style.cssText = 'margin-top:12px;padding:8px 16px;border:1px solid #d8d4f3;border-radius:8px;background:#f7f6ff;color:#393075;font:inherit;cursor:pointer;';
  let controlSessionId;
  const wizard = createImportWizard({ element,
    async getSession(owner) {
      if (owner) return owner;
      if (!ctx.sessions?.create) throw new Error('请在普通会话中执行 /codex-import preview 打开导入窗口。');
      controlSessionId ||= await ctx.sessions.create(); return controlSessionId;
    },
    async onPreview(owner, options) {
      const response = await ctx.remote.commands.execute(owner, `/codex-import preview ${JSON.stringify(options)}`, []);
      if (!response.ok) throw new Error(response.error.message);
      const result = response.value?.result;
      if (!result || result.kind === 'error') throw new Error(result?.text || '未能开始预览，请重试');
      handleResult(owner, 'codex-import', result);
    },
  });
  dialog.append(heading, wizard.node, progress, summary, current, importConfirmation, backButton, attachmentButton, output, confirmation, actions);
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
  openImport = async () => {
    if (tracking && !cancel.hidden) { render(); show(); return; }
    const owner = tracking?.sessionId;
    if (owner) {
      try {
        const result = await ctx.remote.commands.execute(owner, '/codex-import preview', []);
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value) throw new Error('无法打开导入向导');
        handleResult(owner, 'codex-import', result.value.result);
      } catch (error) { output.textContent = error.message; }
    } else handleResult(undefined, 'codex-import', { kind: 'success', text: 'Codex 导入向导' });
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
    backButton.hidden = !preview || !finished;
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
      importButton.textContent = `确认导入 ${p.count} 条对话`;
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
  const onClose = () => { if (!wizard.node.hidden) wizard.cancel(); dialog.close(); if (cancel.hidden) { release(); tracking = undefined; } };
  const onCancel = async () => {
    if (!tracking || cancelling) return;
    cancelling = true; render();
    try {
      const result = await ctx.jobs.kill(tracking.sessionId, tracking.id);
      if (!result.ok) { cancelling = false; output.textContent = `取消失败：${result.error.message}`; cancel.disabled = false; }
      else wizard.discardUpload();
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
  const onDialogCancel = event => { event.preventDefault(); onClose(); };
  dialog.addEventListener('cancel', onDialogCancel);
  cancel.addEventListener('click', onCancel);
  includeContinued.addEventListener('change', updateChoice);
  confirmationInput.addEventListener('input', updateChoice);
  deleteButton.addEventListener('click', onConfirm);
  importButton.addEventListener('click', onImport);
  backButton.addEventListener('click', openImport);
  ctx.effect(() => () => {
    disposed = true; release(); attachmentDetails.dispose(); wizard.dispose();
    close.removeEventListener('click', onClose);
    dialog.removeEventListener('cancel', onDialogCancel);
    cancel.removeEventListener('click', onCancel);
    includeContinued.removeEventListener('change', updateChoice);
    confirmationInput.removeEventListener('input', updateChoice);
    deleteButton.removeEventListener('click', onConfirm);
    importButton.removeEventListener('click', onImport);
    backButton.removeEventListener('click', openImport);
    dialog.remove();
  });
  const handleResult = (sessionId, commandName, result) => {
    if (commandName !== 'codex-import') return;
    if (result.kind !== 'error' && result.text?.startsWith('Codex 导入向导')) {
      release(); tracking = undefined; cancelling = false; importProposal = undefined; proposal = undefined;
      importConfirmation.hidden = true; confirmation.hidden = true; backButton.hidden = true;
      progress.hidden = true; summary.textContent = ''; current.textContent = ''; output.textContent = ''; output.hidden = true;
      attachmentDetails.update(undefined); cancel.hidden = true; close.textContent = '取消'; heading.textContent = '导入对话';
      void wizard.open(sessionId); show(); return;
    }
    const id = /任务编号：(codex-import-[a-f0-9]+)/.exec(result.text || '')?.[1];
    if (id) {
      wizard.hide(); output.hidden = false;
      if (!result.text?.includes('预览任务') && !result.text?.includes('清理')) wizard.forgetUpload();
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
    wizard.hide(); output.hidden = false; backButton.hidden = true;
    proposal = undefined; confirmation.hidden = true;
    importProposal = undefined; importConfirmation.hidden = true;
    progress.hidden = true; summary.textContent = ''; current.textContent = ''; cancel.hidden = true;
    heading.textContent = result.kind === 'error' ? 'Codex 导入未完成' : 'Codex 导入结果';
    output.textContent = result.text || '操作已完成。'; close.textContent = '关闭';
    show();
  };
  ctx.on('command/executed', handleResult);
}

    return { name, inject, apply };
  }
});
