import { isAbsolute } from 'node:path';
import { digest } from './source.js';

export const IMPORT_ID = /^(?:codex|chatgpt)-(?:[a-f0-9]{24}-[a-f0-9]{24}|recovered-[a-f0-9]{24})$/;

export const sourceKey = source => source?.kind === 'chatgpt' ? source.sourceId : source?.codexHome;
export const sourceLocation = source => source?.kind === 'chatgpt' ? source.archivePath : source?.codexHome;
export const sourceLabel = snapshot => snapshot.mode === 'chatgpt' || snapshot.source?.kind === 'chatgpt' ? 'ChatGPT' : 'Codex';
export const sessionPrefix = (home, threadId, cwd) => `${home.startsWith('chatgpt:') ? 'chatgpt' : 'codex'}-${digest([home, threadId, cwd ?? null]).slice(0, 24)}-`;

/** Identity proof shared by browsing and cleanup; copied/forked logs stay out. */
export function isImportedIdentity(id, source, recoverySource) {
  const key = sourceKey(source), location = sourceLocation(source);
  if (source?.format !== 1 || typeof key !== 'string' || typeof location !== 'string' || !isAbsolute(location)
    || (source.kind === 'chatgpt' && !/^chatgpt:[a-f0-9]{64}$/.test(key))
    || typeof source.threadId !== 'string' || !/^[a-f0-9]{64}$/.test(source.fingerprint || '')) return false;
  const expected = sessionPrefix(key, source.threadId, source.destinationCwd ?? source.metadata?.cwd) + source.fingerprint.slice(0, 24);
  return id === expected || (/^(?:codex|chatgpt)-recovered-[a-f0-9]{24}$/.test(id) && recoverySource === expected);
}
