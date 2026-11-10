import * as React from 'react';

export function longMessagePreview(text) {
  if (text.length <= 1200 && text.split('\n').length <= 18) return undefined;
  const lines = text.split('\n');
  let preview = lines.slice(0, 12).join('\n').slice(0, 900);
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return { preview, total: text.length, lines: lines.length };
}

/** Decorate only native plain user-text nodes; references, Q&A and attachments keep their renderers. */
export function LongUserText({ node, raw, nativeText, ...props }) {
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
export const LONG_MESSAGE_CSS = `
.codex-long-message{display:block;max-width:100%;white-space:normal}.codex-long-message-body{display:block;overflow-wrap:anywhere}.codex-long-message-body.expanded{max-height:65vh;min-height:140px;overflow:auto;resize:vertical;padding:8px 0;white-space:pre-wrap}.codex-long-message-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:8px;color:#747d8f;font:12px/1.5 system-ui}.codex-long-message-actions button{background:none;border:1px solid #8a93a535;border-radius:6px;color:inherit;cursor:pointer;font:inherit;padding:4px 9px}.codex-long-message-actions button:disabled{opacity:.4;cursor:default}
`;
export function installLongMessages(ctx) {
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'text', priority: 0,
    inject: () => ({ nativeText: ctx.slots.entries?.('conversation.user.text.node').find(entry => entry.options.key === 'text' && entry.component !== LongUserText)?.component }),
  }, LongUserText));
}
