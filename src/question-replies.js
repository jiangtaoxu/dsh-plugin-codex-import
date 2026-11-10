import * as React from 'react';

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
export function findQuestionReply(text, from = 0) {
  for (let at = text.indexOf(QUESTION_REPLY_OPEN, from); at !== -1; at = text.indexOf(QUESTION_REPLY_OPEN, at + QUESTION_REPLY_OPEN.length)) {
    if (questionReplyIsCode(text, at)) continue;
    const parsed = questionReplyAt(text, at);
    if (parsed) return parsed;
  }
  return undefined;
}

/** A UserText rule preserves native message identity, selection, attachments and actions. */
export const questionReplyRule = {
  id: QUESTION_REPLY_NODE, order: 5,
  match(text, from) {
    const parsed = findQuestionReply(text, from);
    return parsed ? { id: QUESTION_REPLY_NODE, start: parsed.start, end: parsed.end, data: { rows: parsed.rows } } : undefined;
  },
};

export function QuestionReplyView({ node, raw }) {
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

export const QUESTION_REPLY_CSS = `
.codex-question-reply{display:block;margin:6px 0;border:1px solid #7e91c536;border-radius:12px;overflow:hidden;background:#7e91c509;font:14px/1.65 system-ui,sans-serif;white-space:normal;max-width:100%;box-sizing:border-box}
.codex-question-reply-header{display:block;padding:11px 15px;border-bottom:1px solid #7e91c526;font-size:13px;font-weight:600;color:var(--ds-color-text-secondary,#5d6781)}
.codex-question-reply-item{display:block;padding:14px 15px;border-bottom:1px solid #7e91c520;overflow-wrap:anywhere}
.codex-question-reply-label{display:block;font-size:11px;letter-spacing:.03em;color:var(--ds-color-text-tertiary,#7b8391);margin-bottom:4px}
.codex-question-reply-question{display:block;font-weight:550;white-space:pre-wrap;margin-bottom:10px;color:inherit}
.codex-question-reply-answers{display:block}.codex-question-reply-answer{display:block;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 11px;background:#5f976a12;border-left:3px solid #6f9f7b;border-radius:4px;margin:4px 0;color:inherit}
.codex-question-reply-empty{display:block;color:#7b8391;font-style:italic}.codex-question-reply-original{display:inline-block;border:0;background:none;color:var(--ds-color-text-tertiary,#737e94);font:inherit;font-size:12px;cursor:pointer;padding:10px 15px}
.codex-question-reply-raw{display:block;border-top:1px solid #7e91c526;padding:12px 15px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:300px;user-select:text;font:12px/1.6 ui-monospace,monospace}
`;
