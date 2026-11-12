import * as React from 'react';
const sh = React.createElement;

/** Hide only proved imported members; keep unrelated and mixed workspaces intact. */
export function ordinarySidebar(workspaces, sessions, imported) {
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

export function CodexSidebar({ wide = true, expandSidebar, loadCatalog, sessionSource, workspaceSource,
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

export const CODEX_SIDEBAR_CSS = `
.codex-sidebar{height:100%;min-height:0;display:flex;flex-direction:column;font:13px/1.6 system-ui;color:inherit}.codex-sidebar-header{display:flex;align-items:center;gap:8px;padding:10px 16px}.codex-sidebar-header strong{margin-right:auto;font-weight:500}.codex-sidebar-header button{font:11px system-ui;color:#6b7380;background:none;border:0;cursor:pointer}.codex-sidebar>input{margin:0 14px 10px;padding:8px 10px;min-width:0;border:1px solid #8c95a52b;border-radius:8px;background:transparent;color:inherit;font:inherit}.codex-sidebar-body{min-height:0;flex:1;overflow:auto;padding:0 10px 18px}.codex-sidebar-folder{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;padding:9px 8px;font:inherit;cursor:pointer}.codex-sidebar-folder>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codex-sidebar-folder>small{margin-left:auto;color:#7b8290}.codex-sidebar-root{font-weight:600}.codex-sidebar-imports{padding-left:12px;border-left:1px solid #8793a429;margin-left:10px}.codex-sidebar-imports>select{max-width:100%;margin:3px 0 8px;padding:5px;border:1px solid #8793a430;border-radius:7px;background:transparent;color:inherit;font:inherit}.codex-sidebar-imports>small{display:block;color:#7b8290}.codex-sidebar-session{display:flex;gap:5px;align-items:center;text-align:left;width:100%;padding:8px 9px 8px 20px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit}.codex-sidebar-session>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.codex-sidebar-session>small{color:#8d94a3;white-space:nowrap}.codex-sidebar-session:hover,.codex-sidebar-folder:hover{background:#8793a412}.codex-sidebar-session.is-current{background:#536dfe18}.codex-sidebar-more{border:0;background:transparent;padding:8px;color:#5866a5;font:inherit;cursor:pointer}
`;

/** A public single-slot contribution; native services and disk records are untouched. */
export function installImportedSidebar(ctx, options) {
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
