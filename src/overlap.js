import { digest } from './source.js';
import { projectedRecords } from './convert.js';

/** Text evidence only. Equal content across sources is never proof of common identity. */
export function snapshotMessages(snapshot) {
  return projectedRecords(snapshot).flatMap(({ projected }) => {
    if (!projected || !['user', 'assistant'].includes(projected.role)) return [];
    const value = projected.content.filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/\r\n/g, '\n').trim();
    if (!value || /^\[(?:Codex|ChatGPT) /.test(value)) return [];
    return [{ role: projected.role, text: value }];
  });
}

export function eventMessages(events) {
  return events.flatMap(event => {
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined;
    if (!message) return [];
    const value = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/\r\n/g, '\n').trim();
    if (!value || /^\[(?:Codex|ChatGPT) /.test(value) || /^【(?:Codex|ChatGPT) (?:导入信息|增量同步)】/.test(value)) return [];
    return [{ role: message.role, text: value }];
  });
}

const messageHash = message => digest([message.role, message.text]);
const substantial = messages => messages.length >= 2 && messages.some(m => m.role === 'user')
  && messages.some(m => m.role === 'assistant') && messages.reduce((n, m) => n + m.text.length, 0) >= 80;

export class OverlapIndex {
  constructor() { this.full = new Map(); this.messages = new Map(); this.rows = []; }
  add(reference, messages) {
    const row = { ...reference, messageCount: messages.length }; this.rows.push(row);
    if (substantial(messages)) {
      const hash = digest(messages.map(messageHash));
      const rows = this.full.get(hash) || []; rows.push(row); this.full.set(hash, rows);
    }
    for (const hash of new Set(messages.filter(m => m.text.length >= 80).map(messageHash))) {
      const rows = this.messages.get(hash) || []; rows.push(row); this.messages.set(hash, rows);
    }
  }
  compare(messages) {
    const exact = substantial(messages) ? this.full.get(digest(messages.map(messageHash))) || [] : [];
    const matches = new Map();
    for (const hash of new Set(messages.filter(m => m.text.length >= 80).map(messageHash))) {
      for (const row of this.messages.get(hash) || []) {
        const previous = matches.get(row) || { ...row, sharedMessages: 0 };
        previous.sharedMessages++; matches.set(row, previous);
      }
    }
    return { exact, shared: [...matches.values()] };
  }
}

/** Scan through the host's read service, without acquiring writers or activating chats. */
export async function harnessOverlapIndex(services, signal) {
  const index = new OverlapIndex(), warnings = [];
  if (!services.sessionPersistence) return { index, warnings };
  for (const row of await services.sessionPersistence.list({ signal })) {
    signal?.throwIfAborted(); let reader;
    try {
      reader = await services.sessionPersistence.open(row.header.id, 'read', { signal });
      const events = (await reader.read()).events;
      index.add({ kind: 'dsh', id: row.header.id }, eventMessages(events));
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`${row.header.id}：无法读取，未完成内容重合检查（${error.message}）`);
    } finally { await reader?.close(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  return { index, warnings };
}
