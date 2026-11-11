import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

const MAX_ENTRIES = 50000;
const MAX_TOTAL = 4 * 1024 ** 3;
const MAX_JSON = 256 * 1024 ** 2;
const signature = info => [String(info.dev), String(info.ino), info.size, info.mtimeMs, info.ctimeMs];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function archiveName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\')
    || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(p => p === '..' || p === '.')) {
    throw new Error('导出包包含不安全的文件路径');
  }
  return name;
}

/** Bounded ZIP/directory reader. No extraction and no source files are written. */
export class ExportArchive {
  constructor(path) { this.requestedPath = path; this.entries = new Map(); }

  async open(signal) {
    if (!this.requestedPath) throw new Error('ChatGPT 导入需要 archivePath（ZIP 或解压目录）');
    this.path = await realpath(resolve(this.requestedPath));
    const info = await stat(this.path); this.identity = signature(info);
    let total = 0;
    const add = (name, entry) => {
      archiveName(name);
      if (this.entries.has(name)) throw new Error('导出包包含重复文件路径');
      total += entry.size;
      if (this.entries.size >= MAX_ENTRIES || !Number.isSafeInteger(total) || total > MAX_TOTAL) throw new Error('导出包超出文件数或解压大小限制');
      this.entries.set(name, entry);
    };
    try {
      if (info.isDirectory()) {
        const visit = async directory => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            signal?.throwIfAborted();
            const path = join(directory, entry.name);
            const local = await lstat(path);
            if (local.isSymbolicLink()) throw new Error('导出目录不允许包含符号链接');
            if (local.isDirectory()) await visit(path);
            else if (local.isFile()) add(relative(this.path, path).split(sep).join('/'), { path, size: local.size, identity: signature(local) });
            else throw new Error('导出目录包含非普通文件');
          }
        };
        await visit(this.path);
      } else if (info.isFile()) {
        this.zip = await yauzl.openPromise(this.path, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
        for await (const entry of this.zip.eachEntry()) {
          signal?.throwIfAborted(); archiveName(entry.fileName);
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP 不允许包含符号链接');
          if (entry.isEncrypted()) throw new Error('不支持加密的导出包');
          if (!entry.fileName.endsWith('/')) add(entry.fileName, { zipEntry: entry, size: entry.uncompressedSize });
        }
      } else throw new Error('archivePath 不是 ZIP 或目录');
      // Bind confirmation to bytes, not the ZIP filename or a volatile extraction path.
      const hash = createHash('sha256');
      if (this.zip) {
        for await (const chunk of createReadStream(this.path, { signal })) hash.update(chunk);
      } else {
        for (const name of [...this.entries.keys()].sort()) {
          hash.update(JSON.stringify([name, this.entries.get(name).size]));
          for await (const chunk of await this.stream(name, signal)) hash.update(chunk);
        }
      }
      this.fingerprint = hash.digest('hex');
      await this.assertUnchanged(signal);
      return this;
    } catch (error) { this.close(); throw error; }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }

  async assertUnchanged(signal) {
    signal?.throwIfAborted();
    if (!same(signature(await stat(this.path)), this.identity)) throw new Error('导出包发生变化，请重新预览');
    if (!this.zip) for (const entry of this.entries.values()) {
      const physical = await realpath(entry.path);
      const part = relative(this.path, physical);
      if (isAbsolute(part) || part === '..' || part.startsWith('..' + sep)
        || !same(signature(await lstat(entry.path)), entry.identity)) throw new Error('导出目录文件发生变化，请重新预览');
    }
  }

  async stream(name, signal, limit = MAX_TOTAL) {
    archiveName(name);
    const entry = this.entries.get(name);
    if (!entry) throw Object.assign(new Error('导出包中未找到附件文件'), { code: 'ENOENT' });
    if (entry.size > limit) throw new Error('文件超过读取大小限制');
    if (!this.zip) await this.assertFile(entry);
    const input = this.zip ? await this.zip.openReadStreamPromise(entry.zipEntry) : createReadStream(entry.path, { signal });
    const abort = () => input.destroy(signal.reason instanceof Error ? signal.reason : new Error('已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    const archive = this;
    return (async function* () {
      let count = 0, checksum = 0;
      try {
        signal?.throwIfAborted();
        for await (const chunk of input) {
          signal?.throwIfAborted(); count += chunk.length;
          if (count > limit || count > entry.size) throw new Error('文件超过读取大小限制');
          if (entry.zipEntry) checksum = crc32(chunk, checksum);
          yield chunk;
        }
        if (count !== entry.size || (entry.zipEntry && checksum !== entry.zipEntry.crc32)) throw new Error('导出包文件大小或 CRC 校验失败');
        if (!archive.zip) await archive.assertFile(entry);
      } finally { signal?.removeEventListener('abort', abort); input.destroy(); }
    })();
  }

  async assertFile(entry) {
    if (await realpath(entry.path) !== entry.path || !same(signature(await lstat(entry.path)), entry.identity)) throw new Error('导出目录文件发生变化，请重新预览');
  }

  async bytes(name, signal, limit = MAX_JSON) {
    const chunks = [];
    for await (const chunk of await this.stream(name, signal, limit)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  async json(name, signal) { return JSON.parse((await this.bytes(name, signal)).toString('utf8').replace(/^\uFEFF/, '')); }
  close() { this.zip?.close(); this.zip = undefined; }
}
