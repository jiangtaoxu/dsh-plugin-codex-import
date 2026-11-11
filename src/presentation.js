import * as React from 'react';
import { installLongMessages, LONG_MESSAGE_CSS } from './long-messages.js';
import { installImportedSidebar, CODEX_SIDEBAR_CSS } from './sidebar.js';
import { questionReplyRule, QuestionReplyView, QUESTION_REPLY_CSS } from './question-replies.js';

const h = React.createElement;
const PANEL = 'codex-import-browser';
const RECORD = 'codex-import-record';
const RECORD_MARKER = /^\[Codex (?:终端记录|文件变更|MCP|工具|搜索|查看图片|生成图片|function_call|function_call_output|custom_tool_call|custom_tool_call_output|web_search_call|local_shell_call|tool_call|tool_result|computer_call)/;

/** Match only this importer's durable messages, leaving ordinary replies alone. */
export function importedRecord(event) {
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
export const recordDefinition = {
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

export function ImportedRecordCard({ node, useDisclosure, renderFactorySlot, loadImage }) {
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

export const importedFilesDefinition = {
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
export function ImportedFilesCard({ node, openFile }) {
  return h('section', { className: 'codex-import-files', 'aria-label': 'Codex 导入文件附件' },
    ...node.data.files.map((file, index) => h('button', { key: index, type: 'button', className: 'codex-button', disabled: !file.hostPath,
      onClick: () => openFile(file.hostPath), title: file.attachment.name },
      `▤ ${file.attachment.name} · ${(file.attachment.bytes / 1024).toFixed(1)} KB · 打开附件`)));
}

export function filterCatalog(items, { query = '', project = '', archive = 'all' } = {}) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(row => (!project || row.projectKey === project)
    && (archive === 'all' || (archive === 'archived' ? row.archived : !row.archived))
    && words.every(word => `${row.title}\n${row.projectTitle}\n${row.projectPath}\n${row.originalCwd}\n${row.threadId}`.toLocaleLowerCase().includes(word)));
}

export function catalogProjects(items) {
  const groups = new Map();
  for (const row of items) {
    const group = groups.get(row.projectKey) || { key: row.projectKey, title: row.projectTitle, path: row.projectPath, count: 0 };
    group.count++; groups.set(group.key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

export function ImportBrowser({ loadCatalog, openSession, refreshSessions, enableSidebar }) {
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
export function installPresentation(ctx) {
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
  const sidebar = installImportedSidebar(ctx, { loadCatalog, refreshSessions, openSession: id => ctx.uiWorkspace.openSession(id), filterCatalog, catalogProjects });
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
    inject: () => ({ loadCatalog, refreshSessions, openSession: id => ctx.uiWorkspace.openSession(id), enableSidebar: sidebar?.enable }),
  }, ImportBrowser));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 20, label: 'Codex 导入目录',
  }, ({ size = 20 }) => h('span', { style: { fontSize: size, lineHeight: 1 }, 'aria-hidden': true }, '▤')));
  return { async refresh() { await refreshSessions(); sidebar?.refresh(); } };
}
