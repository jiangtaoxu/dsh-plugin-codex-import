import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';

/** Node releases differ in whether one-shot decoding consumes all frames. */
export function decodeZstdFrames(bytes) {
  const output = [];
  let offset = 0;
  while (offset < bytes.length) {
    const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true });
    const consumed = decoded.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset) {
      throw new Error('Zstandard decoder did not consume a valid complete frame');
    }
    output.push(decoded.buffer); offset += consumed;
  }
  return Buffer.concat(output);
}

/** Recover only the audited legacy import case; never rewrite committed logs. */
export function repairImportedHead(header, input) {
  if (header.version !== SESSION_FORMAT_VERSION || header.isSeeded) throw new Error('Unsupported recovery source');
  if (input[0]?.type !== 'codex-import/source') throw new Error('Recovery is restricted to this plugin’s imports');
  const first = input.findIndex(event => event.surfaceOp !== undefined);
  const systems = input.flatMap((event, index) => event.type === 'system/message' ? [index] : []);
  if (systems.length !== 1 || systems[0] <= first || input[systems[0]].surfaceOp !== 'append') {
    throw new Error('The session does not match the legacy misplaced system-head case');
  }
  const systemIndex = systems[0];
  const firstStep = input.slice(0, first).findLast(event => event.type === 'step/start');
  if (!firstStep) throw new Error('The imported surface has no initial step');
  const order = input.map((_, index) => index);
  order.splice(systemIndex, 1); order.splice(first, 0, systemIndex);
  const mapping = [];
  for (const [index, old] of order.entries()) mapping[old] = index;
  const map = seq => {
    if (!Number.isSafeInteger(seq) || mapping[seq] === undefined) throw new Error('Invalid event reference during recovery');
    return mapping[seq];
  };
  const id = `codex-recovered-${createHash('sha256').update(JSON.stringify([header.id, input])).digest('hex').slice(0, 24)}`;
  const events = order.map((old, seq) => {
    const event = structuredClone(input[old]); event.seq = seq;
    if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(map);
    if (event.surfaceOp && event.surfaceOp !== 'append') {
      event.surfaceOp.startSeq = map(event.surfaceOp.startSeq); event.surfaceOp.endSeq = map(event.surfaceOp.endSeq);
    }
    if (['session/title', 'session/title-llm-request'].includes(event.type)) event.data.messageSeqs = event.data.messageSeqs.map(map);
    if (event.type === 'command/done' && event.data.sourceEventSeq !== undefined) event.data.sourceEventSeq = map(event.data.sourceEventSeq);
    if (event.type === 'developer/message' && event.data.headerSeq !== undefined) event.data.headerSeq = map(event.data.headerSeq);
    if (['compaction/summary', 'compaction/prune', 'image/offload'].includes(event.type)) {
      throw new Error('Recovery of compacted/offloaded sessions requires a separate migration');
    }
    if (event.type === 'session-log-deepseek/delivery-accepted') event.data.sessionId = id;
    if (old === systemIndex) { event.data.turn = firstStep.data.turn; event.data.step = firstStep.data.step; }
    return event;
  });
  const time = input.at(-1)?.time || header.createdAt;
  const oldTitle = input.findLast(event => event.type === 'session/title')?.data.title;
  if (oldTitle) events.push({ seq: events.length, type: 'session/title', time,
    data: { title: `${oldTitle}（已恢复）`, messageSeqs: [], source: { kind: 'user' } } });
  events.push({ seq: events.length, type: 'codex-import/recovery', time, ignorable: true,
    data: { sourceSessionId: header.id, reason: 'Relocated the legacy imported system head; source log retained unchanged.' } });
  const repairedHeader = { ...header, id };
  validateStoredEvents(repairedHeader, events);
  assertReleasedV4Relationships({ header: repairedHeader, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
  return { header: repairedHeader, events };
}

/** Write a validated recovery copy alongside the untouched source. */
export async function recoverImportedSession(persistence, id, signal) {
  const snapshot = await persistence.stat(id, { signal });
  const path = snapshot?.location?.path;
  if (!path || !/\.jsonl(?:\.zstd)?$/.test(path)) throw new Error('Recovery requires a materialized JSONL session');
  const bytes = await readFile(path, { signal });
  const text = (path.endsWith('.zstd') ? decodeZstdFrames(bytes) : bytes).toString('utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  const { type, ...header } = rows.shift();
  if (type !== 'session' || header.id !== id) throw new Error('Recovery source identity mismatch');
  const fixed = repairImportedHead(header, rows);
  if (await persistence.stat(fixed.header.id, { signal })) return { status: 'skipped', id: fixed.header.id, repairedOriginal: id };
  const writer = await persistence.create(fixed.header, { signal });
  try { await writer.append(fixed.events, { signal }); await writer.flush({ signal }); }
  finally { await writer.close(); }
  const reader = await persistence.open(fixed.header.id, 'read', { signal });
  try { await reader.read(); } finally { await reader.close(); }
  return { status: 'recovered', id: fixed.header.id, repairedOriginal: id };
}
