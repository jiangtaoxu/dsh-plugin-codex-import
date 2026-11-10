/** Compact attachment totals for the main progress and confirmation views. */
export function attachmentSummaryText(audit, fallback) {
  if (!audit) return `附件引用：图片 ${fallback?.attachmentImages || 0} · 文件 ${fallback?.attachmentFiles || 0} · 不可导入 ${fallback?.attachmentMissing || 0}`;
  const format = row => `${row.unique} 项 / ${row.references} 次引用`;
  return `可恢复：图片 ${format(audit.available.images)}，文件 ${format(audit.available.files)}\n不可导入：图片 ${format(audit.missing.images)}，文件 ${format(audit.missing.files)}` + (audit.reference?.files.references ? `\n代码位置引用（不计入附件）：${format(audit.reference.files)}` : '');
}

/** Full paginated records are fetched on demand, never embedded in job logs. */
export function createAttachmentDetails(button) {
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
