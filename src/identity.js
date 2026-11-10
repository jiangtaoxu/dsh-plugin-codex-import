import { isAbsolute } from 'node:path';
import { digest } from './source.js';

export const IMPORT_ID = /^codex-(?:[a-f0-9]{24}-[a-f0-9]{24}|recovered-[a-f0-9]{24})$/;

/** Identity proof shared by browsing and cleanup; copied/forked logs stay out. */
export function isImportedIdentity(id, source, recoverySource) {
  if (source?.format !== 1 || typeof source.codexHome !== 'string' || !isAbsolute(source.codexHome)
    || typeof source.threadId !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint || '')) return false;
  const expected = `codex-${digest([source.codexHome, source.threadId, source.destinationCwd ?? source.metadata?.cwd ?? null]).slice(0, 24)}-${source.fingerprint.slice(0, 24)}`;
  return id === expected || (/^codex-recovered-[a-f0-9]{24}$/.test(id) && recoverySource === expected);
}
