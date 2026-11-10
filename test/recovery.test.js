import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstdFrames } from '../src/recovery.js';

test('recovery decodes every concatenated Zstandard frame on Node and Electron', () => {
  const frames = ['{"type":"session"}\n', '{"type":"codex-import/source"}\n', '{"type":"user/message"}\n'];
  const bytes = Buffer.concat(frames.map(text => zstdCompressSync(Buffer.from(text))));
  assert.equal(decodeZstdFrames(bytes).toString(), frames.join(''));
});
