/** Browser-side source selection. ZIP bytes use Fetch's Blob body, never JSON/base64. */
export function createImportWizard({ element, getSession, onPreview, request = (...args) => fetch(...args) }) {
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
