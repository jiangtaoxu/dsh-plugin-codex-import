import { createReadStream } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatGPTSource } from '../src/chatgpt-source.js';
import { OverlapIndex, snapshotMessages, eventMessages } from '../src/overlap.js';
import { jsonlLines } from '../src/jsonl.js';
import { readZstdFrames } from '../src/zstd.js';

// Local diagnostic: stdout contains counts and IDs, never conversation text or account details.
const args = process.argv.slice(2), archivePath = args.shift();
if (!archivePath) throw new Error('Usage: node scripts/audit-chatgpt.mjs export.zip [--codex-home PATH] [--dsh-home PATH] [--source-id ID]');
let dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'), sourceId;
const codexHomes = [];
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (!value) throw new Error('Missing argument value');
  if (args[i] === '--codex-home') codexHomes.push(value);
  else if (args[i] === '--dsh-home') dshHome = value;
  else if (args[i] === '--source-id') sourceId = value;
  else throw new Error('Unknown option');
}
if (!codexHomes.length) codexHomes.push(...new Set([process.env.CODEX_HOME, join(homedir(), '.codex')].filter(Boolean)));
const source = await new ChatGPTSource(archivePath, sourceId).open();
try {
  const index = new OverlapIndex(), ids = new Set(), titles = new Map();
  for (const thread of source.list()) {
    ids.add(thread.id);
    if (thread.title) {
      const rows = titles.get(thread.title.trim()) || []; rows.push(thread.id); titles.set(thread.title.trim(), rows);
    }
    index.add({ kind: 'chatgpt', id: thread.id }, snapshotMessages(await source.read(thread)));
  }
  const report = { export: source.summary, sources: [], policy: '同源身份相同则跳过或增量追加；跨来源文本相同仅提示，保留双方，禁止自动合并。' };
  const inspect = (result, id, title, messages, originalId = id) => {
    result.scanned++;
    if (ids.has(originalId)) { result.identicalIds++; result.idMatches.push(id); }
    if (title && titles.has(title.trim())) result.identicalTitles++;
    const matches = index.compare(messages);
    if (matches.exact.length) result.exactTextSequences++;
    if (matches.shared.length) result.sharedLongMessages++;
    for (const m of matches.exact) result.exactExportIds.add(m.id);
    for (const m of matches.shared) result.sharedExportIds.add(m.id);
    if ((matches.exact.length || matches.shared.length) && result.examples.length < 20) result.examples.push({ localId: id, exact: matches.exact, shared: matches.shared });
  };
  const fresh = (kind, path) => ({ kind, path, scanned: 0, identicalIds: 0, idMatches: [], identicalTitles: 0, exactTextSequences: 0,
    sharedLongMessages: 0, exactExportIds: new Set(), sharedExportIds: new Set(), examples: [], errors: [] });
  for (const home of new Set(await Promise.all(codexHomes.map(p => realpath(resolve(p)).catch(() => resolve(p)))))) {
    const result = fresh('codex', home); report.sources.push(result);
    let state, history;
    try {
      const files = await readdir(home);
      const latest = stem => files.filter(f => new RegExp(`^${stem}_\\d+\\.sqlite$`).test(f)).sort((a, b) => Number(b.match(/_(\d+)\./)[1]) - Number(a.match(/_(\d+)\./)[1]))[0];
      const stateFile = latest('state'), historyFile = latest('thread_history');
      if (stateFile) state = new DatabaseSync(join(home, stateFile), { readOnly: true });
      if (historyFile) history = new DatabaseSync(join(home, historyFile), { readOnly: true });
      const threads = state ? state.prepare('SELECT id,title,rollout_path FROM threads ORDER BY id').all() : [];
      const indexed = new Map(threads.map(t => [t.id, t]));
      const groups = new Map();
      if (history) {
        const columns = history.prepare('PRAGMA table_info(thread_items)').all().map(c => c.name);
        const where = columns.includes('item_type') ? " WHERE item_type IN ('userMessage','agentMessage')" : '';
        for (const row of history.prepare('SELECT thread_id,item_id,rollout_ordinal,item_json FROM thread_items' + where + ' ORDER BY thread_id,rollout_ordinal,item_id').iterate()) {
          const record = { key: row.item_id, item: JSON.parse(row.item_json) };
          if (!['userMessage', 'agentMessage'].includes(record.item.type)) continue;
          const rows = groups.get(row.thread_id) || []; rows.push(record); groups.set(row.thread_id, rows);
        }
      }
      for (const [id, records] of groups) {
        inspect(result, id, indexed.get(id)?.title, snapshotMessages({ mode: 'sqlite', records, supplemental: [] })); indexed.delete(id);
      }
      // Indexed threads without SQLite bodies can still have legacy rollout messages.
      for (const thread of indexed.values()) {
        try {
          const supplemental = [];
          if (thread.rollout_path && await stat(thread.rollout_path).catch(() => false)) {
            let i = 0;
            for await (const line of jsonlLines(createReadStream(thread.rollout_path))) {
              if (!line.trim()) continue;
              const item = JSON.parse(line);
              if (['response_item', 'event_msg'].includes(item.type)) supplemental.push({ key: String(i++), item });
            }
          }
          inspect(result, thread.id, thread.title, snapshotMessages({ mode: 'jsonl', records: [], supplemental }));
        } catch (error) { result.errors.push({ id: thread.id, error: error.message }); }
      }
    } catch (error) { result.errors.push({ error: error.message }); }
    finally { state?.close(); history?.close(); }
  }
  const result = fresh('dsh', resolve(dshHome)); report.sources.push(result);
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    // Read only the latest generation from each session, not migration backups.
    const generations = entries.filter(e => e.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name))
      .sort((a, b) => Number(/\.v(\d+)/.exec(b.name)?.[1] || 0) - Number(/\.v(\d+)/.exec(a.name)?.[1] || 0));
    if (generations.length) {
      const path = join(directory, generations[0].name);
      try {
        const events = []; let header;
        for await (const line of jsonlLines(path.endsWith('.zstd') ? readZstdFrames(path) : createReadStream(path))) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (!header) header = event; else events.push(event);
        }
        const origin = events.find(e => e.type === 'codex-import/source')?.data;
        inspect(result, header.id, events.findLast(e => e.type === 'session/title')?.data.title, eventMessages(events), origin?.threadId || header.id);
      } catch (error) { result.errors.push({ file: path, error: error.message }); }
    }
    for (const entry of entries) if (entry.isDirectory()) await visit(join(directory, entry.name));
  };
  try { await visit(join(resolve(dshHome), 'sessions')); } catch (error) { result.errors.push({ error: error.message }); }
  for (const s of report.sources) {
    s.exactExportConversations = s.exactExportIds.size; s.sharedExportConversations = s.sharedExportIds.size;
    delete s.exactExportIds; delete s.sharedExportIds;
  }
  console.log(JSON.stringify(report, null, 2));
} finally { source.close(); }
