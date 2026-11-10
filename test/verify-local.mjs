// Explicitly invoked, read-only verification against a real Codex home.
import { CodexSource } from '../src/source.js';
import { convertSnapshot } from '../src/convert.js';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4';

const source = await new CodexSource(process.argv[2]).open();
const report = { total: 0, withBody: 0, metadataOnly: 0, items: 0, rolloutRecords: 0, nativeMessages: 0, failures: [] };
try {
  for (const thread of source.list()) {
    report.total++;
    try {
      const snapshot = await source.read(thread);
      snapshot.destinationCwd = '/tmp/codex-import-validation-only';
      const { header, events } = convertSnapshot(source.home, snapshot, SESSION_FORMAT_VERSION);
      validateStoredEvents(header, events);
      assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
      report[snapshot.mode === 'metadata-only' ? 'metadataOnly' : 'withBody']++;
      report.items += snapshot.records.length;
      report.rolloutRecords += snapshot.supplemental.length;
      report.nativeMessages += events.filter(e => e.type === 'user/message' || e.type === 'assistant/message').length;
    } catch (error) { report.failures.push({ threadId: thread.id, error: error.message }); }
    await new Promise(resolve => setImmediate(resolve));
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
} finally { source.close(); }
