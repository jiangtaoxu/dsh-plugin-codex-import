import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsonlLines } from './jsonl.js';
import { createHash } from 'node:crypto';

/** Stable JSON digest; record ordering is part of an imported snapshot. */
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function latestDatabase(home, stem) {
  const candidates = (await readdir(home)).flatMap(name => {
    const match = new RegExp(`^${stem}_(\\d+)\\.sqlite$`).exec(name);
    return match ? [{ name, version: Number(match[1]) }] : [];
  }).sort((a, b) => b.version - a.version);
  if (!candidates.length) return undefined;
  const db = new DatabaseSync(join(home, candidates[0].name), { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  return db;
}

function hasTable(db, name) {
  return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Read JSONL incrementally. A torn last line is reported rather than imported. */
async function* jsonLines(path, warnings, signal) {
  const input = createReadStream(path);
  const lines = jsonlLines(input);
  let number = 0;
  let pending;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      number++;
      if (pending) throw new Error(`${path}:${pending}: invalid JSON before end of file`);
      if (!line.trim()) continue;
      try { yield { value: JSON.parse(line), line: number }; }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        pending = number;
      }
    }
    if (pending) warnings.push(`${path}:${pending}: ignored incomplete final JSON line`);
  } finally { await lines.return(); input.destroy(); }
}

async function* rollouts(directory) {
  if (!(await exists(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* rollouts(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

function milliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value < 1e11 ? value * 1000 : value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/** Read-only access to both modern SQLite and legacy JSONL Codex histories. */
export class CodexSource {
  constructor(home) { this.requestedHome = home; this.warnings = []; }

  async open(signal) {
    signal?.throwIfAborted();
    this.home = await realpath(resolve(this.requestedHome || process.env.CODEX_HOME || join(homedir(), '.codex')));
    this.state = await latestDatabase(this.home, 'state');
    try {
      this.history = await latestDatabase(this.home, 'thread_history');
      this.threads = new Map();
      if (this.state && !hasTable(this.state, 'threads')) throw new Error('Codex state database has no threads table');
      if (this.history && !hasTable(this.history, 'thread_items')) throw new Error('Codex history database has no thread_items table');
      const projects = new Map();
      if (hasTable(this.state, 'projects')) {
        for (const project of this.state.prepare('SELECT * FROM projects').all()) projects.set(project.id, { ...project });
      }
      if (this.state) {
        const rows = this.state.prepare('SELECT * FROM threads ORDER BY id').all();
        rows.sort((a, b) => milliseconds(a.created_at_ms ?? a.created_at) - milliseconds(b.created_at_ms ?? b.created_at));
        for (const row of rows) {
          this.threads.set(row.id, { ...row, project: projects.get(row.project_id) ?? null, files: [] });
        }
      }
      for (const directory of ['sessions', 'archived_sessions']) {
        for await (const path of rollouts(join(this.home, directory))) {
          signal?.throwIfAborted();
          // Only session_meta is needed for discovery, not the entire transcript.
          for await (const { value } of jsonLines(path, this.warnings, signal)) {
            if (value.type === 'session_meta' && value.payload?.id) {
              const meta = value.payload;
              const thread = this.threads.get(meta.id) ?? {
                id: meta.id, title: '', cwd: meta.cwd, created_at_ms: milliseconds(meta.timestamp ?? value.timestamp),
                archived: directory === 'archived_sessions' ? 1 : 0, project: null, files: [],
              };
              if (!thread.files.includes(path)) thread.files.push(path);
              this.threads.set(meta.id, thread);
              break;
            }
          }
        }
      }
      // Orphaned message histories are recoverable even if their index row disappeared.
      if (this.history) {
        for (const { thread_id } of this.history.prepare('SELECT DISTINCT thread_id FROM thread_items').all()) {
          if (!this.threads.has(thread_id)) this.threads.set(thread_id, { id: thread_id, title: '', files: [], project: null });
        }
        if (hasTable(this.history, 'thread_realtime_items')) {
          for (const { thread_id } of this.history.prepare('SELECT DISTINCT thread_id FROM thread_realtime_items').all()) {
            if (!this.threads.has(thread_id)) this.threads.set(thread_id, { id: thread_id, title: '', files: [], project: null });
          }
        }
      }
      if (!this.state && !this.history && !this.threads.size) throw new Error(`No Codex conversation data found in ${this.home}`);
      return this;
    } catch (error) { this.close(); throw error; }
  }

  list(options = {}) {
    return [...this.threads.values()].filter(t =>
      (options.includeArchived !== false || !t.archived)
      && (!options.cwd || t.cwd === options.cwd)
      && (!options.threadIds?.length || options.threadIds.includes(t.id)));
  }

  /** Read one consistent SQLite transaction, falling back to rollout records. */
  async read(thread, signal) {
    signal?.throwIfAborted();
    const records = [];
    const turns = [];
    if (this.history) {
      this.history.exec('BEGIN');
      try {
        if (hasTable(this.history, 'thread_turns')) turns.push(...this.history.prepare(
          'SELECT * FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal,turn_id').all(thread.id).map(row => ({ ...row })));
        const items = new Map();
        for (const row of this.history.prepare(
          'SELECT * FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal,turn_id,item_id').iterate(thread.id)) {
          signal?.throwIfAborted();
          items.set(row.item_id, row);
        }
        if (hasTable(this.history, 'thread_realtime_items')) {
          for (const row of this.history.prepare('SELECT * FROM thread_realtime_items WHERE thread_id=?').iterate(thread.id)) {
            const previous = items.get(row.item_id);
            if (!previous || row.rollout_ordinal > previous.rollout_ordinal) items.set(row.item_id, row);
          }
        }
        for (const row of [...items.values()].sort((a, b) => a.rollout_ordinal - b.rollout_ordinal || a.item_id.localeCompare(b.item_id))) {
          const { item_json, ...storageRow } = row;
          records.push({ key: row.item_id, turn: row.turn_id ?? null, time: milliseconds(row.created_at_ms),
            item: JSON.parse(item_json), storageRow });
        }
        this.history.exec('COMMIT');
      } catch (error) { this.history.exec('ROLLBACK'); throw error; }
    }
    const createdAt = milliseconds(thread.created_at_ms ?? thread.created_at) || records[0]?.time || 0;
    const metadata = { ...thread, files: [...thread.files] };
    if (thread.rollout_path && !metadata.files.includes(thread.rollout_path) && await exists(thread.rollout_path)) {
      metadata.files.push(thread.rollout_path);
    }
    // SQLite is the authoritative UI history. Rollouts are retained losslessly as
    // supplemental records, but projected only when no SQLite history survives.
    const supplemental = [];
    for (const path of metadata.files.sort()) {
      for await (const { value, line } of jsonLines(path, this.warnings, signal)) {
        supplemental.push({ key: `${path}:${line}`, time: milliseconds(value.timestamp), item: value });
      }
    }
    const mode = records.length ? 'sqlite' : supplemental.length ? 'jsonl' : 'metadata-only';
    const snapshot = { thread: metadata, createdAt, mode, turns, records, supplemental };
    // File locations and volatile index bookkeeping do not define transcript identity.
    snapshot.fingerprint = digest({ id: thread.id, title: thread.title, cwd: thread.cwd,
      archived: thread.archived, records, supplemental, turns, createdAt });
    return snapshot;
  }

  close() { this.history?.close(); this.state?.close(); this.history = this.state = undefined; }
}
