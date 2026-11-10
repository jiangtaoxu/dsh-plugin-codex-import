import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

/** Decode exact standard frames: Electron's streaming decoder stops at frame 1.
 * Frame layout follows RFC 8878; no private Node APIs or decompressed corpus copy.
 */
export async function* readZstdFrames(path, signal) {
  const bytes = await readFile(path, { signal });
  let offset = 0;
  const requireBytes = count => {
    if (offset + count > bytes.length) throw new Error('压缩会话日志不完整，已保留');
  };
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const start = offset;
    requireBytes(5);
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('压缩会话日志帧无效，已保留');
    offset += 4;
    const descriptor = bytes[offset++];
    if (descriptor & 0x18) throw new Error('压缩会话日志帧头无效，已保留');
    const single = !!(descriptor & 0x20);
    const sizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    const headerBytes = (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
    requireBytes(headerBytes); offset += headerBytes;
    for (;;) {
      requireBytes(3);
      const block = bytes.readUIntLE(offset, 3); offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('压缩会话日志数据块无效，已保留');
      const payload = type === 1 ? 1 : block >>> 3;
      requireBytes(payload); offset += payload;
      if (block & 1) break;
    }
    if (descriptor & 4) { requireBytes(4); offset += 4; }
    yield zstdDecompressSync(bytes.subarray(start, offset));
    await new Promise(resolve => setImmediate(resolve));
  }
}
