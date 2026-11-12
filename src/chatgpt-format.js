const CHATGPT_FORMAT_LIMIT = 2 * 1024 * 1024;
const CHATGPT_LAYOUT_TAGS = new Set(['box', 'row', 'grid', 'grid-item', 'stack', 'card', 'text', 'title', 'icon', 'badge', 'divider', 'form', 'radio-group', 'radio', 'checkbox-group', 'checkbox', 'button', 'input', 'textarea', 'select', 'option', 'label', 'slider', 'table', 'table-row', 'table-cell', 'caption', 'Link', 'AsyncImage', 'Chart']);
const CHATGPT_BLOCK_TAGS = new Set(['box', 'row', 'grid', 'grid-item', 'stack', 'card', 'form', 'radio-group', 'checkbox-group', 'select', 'table', 'table-row', 'caption']);

function chatGPTSafeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function chatGPTEscape(value) { return String(value ?? '').replace(/[\\`*_[\]<>]/g, '\\$&'); }

/** Protect authored fenced/inline code before interpreting exported UI syntax. */
function chatGPTProtectCode(text) {
  const blocks = [], prefix = '\u0000CHATGPT_CODE_';
  if (text.includes(prefix)) return undefined;
  const protect = value => { const key = `${prefix}${blocks.length}\u0000`; blocks.push(value); return key; };
  const lines = text.split('\n'); let fence, pending = [], output = [];
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      pending.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        output.push(protect(pending.join('\n'))); pending = []; fence = undefined;
      }
    } else if (marker) { fence = { char: marker[1][0], length: marker[1].length }; pending = [line]; }
    else output.push(line);
  }
  if (pending.length) output.push(protect(pending.join('\n')));
  const safe = output.join('\n').replace(/(`+)([^`]|(?!\1)`)*?\1/g, value => protect(value));
  return { text: safe, restore: value => value.replace(/\u0000CHATGPT_CODE_(\d+)\u0000/g, (match, id) => blocks[Number(id)] ?? match) };
}

/** Balanced braces/quotes keep event-handler arrows and > in strings inside their tag. */
function chatGPTTagAt(value, start) {
  const match = /^<(\/)?([A-Za-z][\w-]*)\b/.exec(value.slice(start));
  if (!match) return undefined;
  let braces = 0, quote, escaped = false;
  for (let i = start + match[0].length; i < Math.min(value.length, start + 65536); i++) {
    const char = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
    } else if ('"\'`'.includes(char)) quote = char;
    else if (char === '{') braces++;
    else if (char === '}') { if (!braces) return undefined; braces--; }
    else if (char === '>' && !braces) {
      const source = value.slice(start, i + 1);
      return { name: match[2], close: !!match[1], selfClosing: /\/\s*>$/.test(source), source, end: i + 1 };
    }
  }
  return undefined;
}
function chatGPTAttribute(tag, name) {
  const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*"([^"]*)"\\s*\\}|([^\\s>]+))`);
  const match = expression.exec(tag.source);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4]).replace(/\/$/, '') : undefined;
}
function chatGPTDirectiveEnd(text, start) {
  let depth = 0, quote, escaped = false;
  for (let i = start; i < Math.min(text.length, start + 65536); i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
    } else if ('"\'`'.includes(char)) quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
}

/** Index explicit reference IDs only; search-result ordering never proves a citation match. */
function chatGPTCitationLinks(metadata) {
  const links = new Map();
  const rows = [...(Array.isArray(metadata?.content_references) ? metadata.content_references : []),
    ...(Array.isArray(metadata?.conversation_context_citation_metadata) ? metadata.conversation_context_citation_metadata.filter(r => !r.deleted).map(r => r.citation) : [])];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = chatGPTSafeUrl(row.url);
    if (!url) continue;
    const ids = new Set([row.ref_id, row.reference_id, ...(Array.isArray(row.refs) ? row.refs.flatMap(r => typeof r === 'string' ? [r] : [r?.ref_id, r?.reference_id]) : [])].filter(v => typeof v === 'string'));
    for (const match of String(row.matched_text || '').matchAll(/(?:ref=["']([^"']+)["']|\ue202([^\ue201\ue202]+))/g)) ids.add(match[1] || match[2]);
    for (const id of ids) links.set(id, url);
  }
  return links;
}

function chatGPTStaticWidget(kind, payload) {
  let data;
  try { data = JSON.parse(payload); } catch { return undefined; }
  if (kind === 'image_group') {
    const queries = Array.isArray(data.query) ? data.query.filter(q => typeof q === 'string') : typeof data.query === 'string' ? [data.query] : [];
    return `〔原图片组${queries.length ? '：' + queries.map(chatGPTEscape).join('、') : Array.isArray(data.image_refs) ? `：${data.image_refs.length} 条图片引用` : ''}〕`;
  }
  if (kind === 'entity_metadata' && Array.isArray(data)) return data.slice(1, 3).filter(v => typeof v === 'string').map(chatGPTEscape).join(' · ');
  if (kind !== 'genui' || !data || typeof data !== 'object') return undefined;
  if (data.suggest_automation) {
    const row = data.suggest_automation;
    return `\n\n**原自动化建议${typeof row.title === 'string' ? '：' + chatGPTEscape(row.title) : ''}**${typeof row.prompt === 'string' ? '\n\n' + row.prompt : ''}\n\n> 这是导出中的历史建议，未创建自动化任务。\n\n`;
  }
  if (data.map_widget) return '\n\n〔原地图组件；地点信息见正文〕\n\n';
  if (data.learning_viz) {
    const row = data.learning_viz;
    return `\n\n〔原交互演示${typeof row.title === 'string' ? '：' + chatGPTEscape(row.title) : ''}〕\n\n`;
  }
  return undefined;
}

/** Read-only Markdown projection of ChatGPT-specific rich text. No exported JS/HTML is executed. */
export function normalizeChatGPTText(value, metadata = {}) {
  if (typeof value !== 'string' || value.length > CHATGPT_FORMAT_LIMIT) return { text: value, changed: false };
  const protectedCode = chatGPTProtectCode(value);
  if (!protectedCode) return { text: value, changed: false };
  let input = protectedCode.text;
  const hasLayout = /<(?:box|row|grid|grid-item|radio-group|checkbox-group)\b|\{@body\b/.test(input);
  const links = chatGPTCitationLinks(metadata), unresolved = new Map();
  const citation = ids => ids.split(/[\s,]+/).filter(id => id && !/^L\d+(?:-L?\d+)?$/.test(id)).map(id => {
    const url = links.get(id);
    if (url) return `[来源](<${url}>)`;
    if (!unresolved.has(id)) unresolved.set(id, unresolved.size + 1);
    return `〔来源 ${unresolved.get(id)}〕`;
  }).join('');
  // Legacy exported private-use tokens carry either JSON labels or source IDs.
  input = input.replace(/\ue200([^\ue201\ue202]+)(?:\ue202([^\ue201]*))?\ue201/g, (original, kind, payload = '') => {
    if (kind === 'cite' || kind === 'filecite' || kind === 'memcite') return citation(payload.replace(/\ue202/g, ' '));
    if (kind === 'entity' || kind === 'product_entity') {
      try { const parts = JSON.parse(payload); if (Array.isArray(parts) && typeof parts[1] === 'string') return chatGPTEscape(parts[1]); } catch {}
      return original;
    }
    if (kind === 'url') { const url = chatGPTSafeUrl(payload); return url ? `<${url}>` : original; }
    if (kind === 'message_reaction') return payload;
    if (['genui', 'image_group', 'entity_metadata'].includes(kind)) return chatGPTStaticWidget(kind, payload) ?? original;
    if (kind === 'video') { const [title, ...refs] = payload.split('\ue202'); return `原视频：${chatGPTEscape(title)}${refs.length ? ' ' + citation(refs.join(' ')) : ''}`; }
    return original;
  });
  const stack = []; let output = '', cursor = 0, layoutChanged = false, forms = false;
  const appendText = (text, at) => {
    if (stack.at(-1)?.name === 'table' && !text.trim()) return;
    if (hasLayout && stack.length) {
      const baseline = stack.at(-1).indent;
      text = text.replace(/(^|\n)([ \t]+)/g, (all, line, whitespace, offset) => {
        if (offset === 0 && !line && at > 0 && input[at - 1] !== '\n') return all;
        const remove = Math.min(baseline, whitespace.length); return line + whitespace.slice(remove);
      });
    }
    output += stack.some(s => s.name === 'table-cell') ? text.replace(/\s*\n\s*/g, ' ') : text;
  };
  while (cursor < input.length) {
    const nextTag = input.indexOf('<', cursor), nextDirective = hasLayout ? input.indexOf('{@body', cursor) : -1;
    const next = nextTag < 0 ? nextDirective : nextDirective < 0 ? nextTag : Math.min(nextTag, nextDirective);
    if (next < 0) { appendText(input.slice(cursor), cursor); break; }
    appendText(input.slice(cursor, next), cursor);
    if (next === nextDirective) {
      const end = chatGPTDirectiveEnd(input, next);
      if (end) { layoutChanged = true; cursor = end; continue; }
    }
    const tag = chatGPTTagAt(input, next);
    if (!tag) { output += input[next]; cursor = next + 1; continue; }
    if (tag.name === 'Cite' || tag.name === 'MemoryCite') { if (!tag.close) output += citation(chatGPTAttribute(tag, 'ref') || 'unknown'); cursor = tag.end; continue; }
    if (tag.name === 'Entity' && tag.close) { cursor = tag.end; continue; }
    if (tag.name === 'Entity' && !tag.close) {
      const name = chatGPTAttribute(tag, 'value') || chatGPTAttribute(tag, 'name');
      if (name) { output += chatGPTEscape(name); const location = chatGPTAttribute(tag, 'location'); if (location) output += `（${chatGPTEscape(location)}）`; cursor = tag.end; continue; }
    }
    if (!hasLayout || !CHATGPT_LAYOUT_TAGS.has(tag.name)) { output += tag.source; cursor = tag.end; continue; }
    layoutChanged = true;
    if (['form', 'slider', 'radio-group', 'checkbox-group'].includes(tag.name)) forms = true;
    const isBlock = CHATGPT_BLOCK_TAGS.has(tag.name);
    if (tag.close) {
      const index = stack.map(s => s.name).lastIndexOf(tag.name), context = index >= 0 ? stack[index] : undefined;
      if (index >= 0) stack.splice(index);
      if (context?.bold) output += '**';
      if (tag.name === 'Link' && context?.url) output += `](<${context.url}>)`;
      if (tag.name === 'table-cell') output += ' | ';
      else if (tag.name === 'table-row') {
        output += '\n'; const table = stack.findLast(s => s.name === 'table');
        if (table && !table.rows++) output += '| ' + Array(context?.cells || 1).fill('---').join(' | ') + ' |\n';
      } else if (isBlock || ['radio', 'checkbox', 'option', 'button', 'label', 'title'].includes(tag.name)) output += '\n\n';
    } else {
      const lineStart = input.lastIndexOf('\n', next - 1) + 1;
      const indentation = /^[ \t]*/.exec(input.slice(lineStart, next))[0].length;
      const bold = tag.name === 'text' && /^(?:medium|semibold|bold)$/.test(chatGPTAttribute(tag, 'weight') || '');
      const url = tag.name === 'Link' ? chatGPTSafeUrl(chatGPTAttribute(tag, 'href') || chatGPTAttribute(tag, 'to') || chatGPTAttribute(tag, 'url')) : undefined;
      if (tag.name === 'table-row') output += (output.endsWith('\n') ? '' : '\n') + '| ';
      else if (isBlock) output += '\n\n';
      if (tag.name === 'table-cell') { const row = stack.findLast(s => s.name === 'table-row'); if (row) row.cells++; }
      if (tag.name === 'title') output += '\n\n### ';
      else if (tag.name === 'Link') {
        if (tag.selfClosing) { const label = chatGPTEscape(chatGPTAttribute(tag, 'label') || chatGPTAttribute(tag, 'title') || url || '原链接'); output += url ? `[${label}](<${url}>)` : label; }
        else if (url) output += '[';
      }
      else if (tag.name === 'AsyncImage') {
        const label = chatGPTEscape(chatGPTAttribute(tag, 'alt') || '原图片内容'), imageUrl = chatGPTSafeUrl(chatGPTAttribute(tag, 'src'));
        output += imageUrl ? `[${label}](<${imageUrl}>)` : `〔${label}〕`;
      } else if (tag.name === 'Chart') output += `〔原图表${chatGPTAttribute(tag, 'title') ? '：' + chatGPTEscape(chatGPTAttribute(tag, 'title')) : ''}〕`;
      else if (tag.name === 'slider') output += '〔原滑块控件〕';
      if (tag.name === 'divider') output += '\n\n---\n\n';
      else if (['radio', 'checkbox', 'option'].includes(tag.name)) output += '\n- ';
      else if (tag.name === 'button') output += '\n\n原按钮：';
      else if (tag.name === 'badge') output += ' ';
      else if (tag.name === 'input' || tag.name === 'textarea') {
        const label = chatGPTAttribute(tag, 'placeholder') || chatGPTAttribute(tag, 'label'); if (label) output += `〔${chatGPTEscape(label)}〕`;
      }
      if (bold) output += '**';
      if (!tag.selfClosing && !['divider', 'input'].includes(tag.name)) stack.push({ name: tag.name, indent: indentation + 2, bold, url, rows: 0, cells: 0 });
      else if (bold) output += '**';
    }
    cursor = tag.end;
  }
  if (layoutChanged) {
    output = output.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+(?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n')
      .replace(/^(\*\*)?(\d{1,2})(\*\*)?\s*\n\n(?=\*\*|[^\s])/gm, '$2. ').trim();
    if (forms) output += '\n\n> 原交互表单已转为静态内容，选项和按钮仅供查看。';
  }
  if (unresolved.size) output += '\n\n> 引用说明：导出包未保留' + [...unresolved.values()].map(n => `来源 ${n}`).join('、') + ' 与链接的明确对应关系，需回原对话核对。';
  const result = protectedCode.restore(output);
  return { text: result, changed: result !== value, layout: layoutChanged, unresolvedCitations: unresolved.size };
}
