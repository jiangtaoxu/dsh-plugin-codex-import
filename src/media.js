import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './source.js';
import { projectedRecords } from './convert.js';
import { prepareChatGPTAttachments } from './chatgpt-media.js';

const IMAGE_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
const MIME_TYPES = new Set(IMAGE_TYPES.values());
const DEFAULT_LIMIT = 100 * 1024 * 1024;
const textOf = blocks => (blocks || []).filter(block => ['text', 'input_text', 'output_text'].includes(block?.type)).map(block => block.text || '').join('\n');

function messageContent(snapshot, record) {
  if (snapshot.mode === 'sqlite' && record.item.type === 'userMessage') return record.item.content || [];
  if (snapshot.mode === 'jsonl' && record.item.type === 'response_item' && record.item.payload?.type === 'message') return record.item.payload.content || [];
  return undefined;
}

/** Explicit upload wrappers only: ordinary code paths in prose are not attachments. */
export function mentionedFiles(value) {
  const start = /^# Files (?:mentioned|pasted) by the user:\s*$/m.exec(value);
  if (!start) return [];
  const section = value.slice(start.index).split(/^## My request:\s*$/m)[0];
  return [...section.matchAll(/^## .+: (\/[^\r\n]+)\s*$/gm)].map(match => ({ path: match[1].trim() }));
}

function imageSource(block) {
  const url = block.url ?? block.image_url;
  return block.path ?? block.file_path ?? (typeof url === 'object' ? url?.url : url);
}

function imageType(bytes, path) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return IMAGE_TYPES.get(extname(path || '').toLowerCase());
}

function pathOf(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('附件路径无效');
  if (/^https?:/i.test(value)) throw new Error('远程附件未自动下载');
  if (value.startsWith('file:')) return fileURLToPath(value);
  if (isAbsolute(value)) return value;
  if (!cwd || !isAbsolute(cwd)) throw new Error('相对附件路径没有原项目目录');
  return resolve(cwd, value);
}

function inlineImage(value, limit) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]*)$/i.exec(value);
  if (!match || !MIME_TYPES.has(match[1].toLowerCase())) throw new Error('内嵌图片格式不受支持');
  const encoded = match[2].replace(/\s/g, '');
  if (encoded.length > Math.ceil(limit / 3) * 4) throw new Error('附件超过导入大小限制');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('内嵌图片编码无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > limit) throw new Error('附件超过导入大小限制');
  return { bytes, mediaType: match[1].toLowerCase(), name: `Codex 图片.${match[1].split('/')[1]}` };
}

/** Stable source identity for counts; missing paths can still be normalized. */
function auditSource(value, cwd, kind, result) {
  let source, identity;
  if (typeof value === 'string' && value.startsWith('data:')) {
    const encoded = value.slice(value.indexOf(',') + 1).replace(/\s/g, '');
    identity = 'inline:' + createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');
    source = `内嵌图片（摘要 ${identity.slice(7, 23)}）`;
  } else {
    try { source = pathOf(value, cwd); if (isAbsolute(source)) source = resolve(source); } catch { source = typeof value === 'string' ? value : '缺少附件路径'; }
    identity = source.startsWith('/') ? 'path:' + resolve(source) : 'reference:' + digest([cwd, source]);
  }
  const type = result.type || (kind === 'image' || IMAGE_TYPES.has(extname(source.split(/[?#]/)[0]).toLowerCase()) ? 'image' : 'file');
  return { identity, source, name: source.startsWith('内嵌图片') ? '内嵌图片' : basename(source), type,
    reasonCode: result.failure?.code, detail: result.failure?.detail };
}
function attachmentFailure(error) {
  const detail = error.code === 'ENOENT' ? '原文件已不存在' : ['EACCES', 'EPERM'].includes(error.code) ? '原文件无读取权限' : error.message || String(error);
  let code = 'other';
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') code = 'missing';
  else if (['EACCES', 'EPERM'].includes(error.code)) code = 'permission';
  else if (/TOO_LARGE|TOO_MANY_PIXELS/.test(error.code || '') || /大小限制|pixel limit|byte limit|size limit/i.test(detail)) code = 'too-large';
  else if (error.code === 'INVALID_IMAGE' || /图片格式|图片编码|malformed image/i.test(detail)) code = 'format';
  else if (/远程附件/.test(detail)) code = 'remote';
  else if (/路径|原项目目录/.test(detail)) code = 'path';
  else if (/发生变化/.test(detail)) code = 'changed';
  else if (/服务不可用/.test(detail)) code = 'service';
  return { code, detail };
}

/** Never correlate two different prompts merely by their order or timestamp. */
function rolloutImages(snapshot) {
  const byText = new Map();
  for (const record of snapshot.supplemental) {
    const message = record.item.type === 'response_item' ? record.item.payload : undefined;
    if (message?.type !== 'message' || message.role !== 'user') continue;
    const images = [], paths = [], plain = [];
    const content = message.content || [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      // Codex surrounds screenshots with separate, generated text/image/text
      // triples. Strip only verified triples, and later require the exact paths.
      const wrapper = ['text', 'input_text'].includes(block.type)
        ? /^<image name=\[Image #\d+\] path="([^"\r\n]+)">$/.exec((block.text || '').trim()) : undefined;
      if (wrapper && ['input_image', 'image'].includes(content[i + 1]?.type)
        && ['text', 'input_text'].includes(content[i + 2]?.type) && content[i + 2].text?.trim() === '</image>') {
        const value = imageSource(content[i + 1]);
        if (typeof value === 'string' && value.startsWith('data:')) { images.push(value); paths.push(wrapper[1]); }
        i += 2;
      } else if (['input_image', 'image'].includes(block.type)) {
        const value = imageSource(block);
        if (typeof value === 'string' && value.startsWith('data:')) { images.push(value); paths.push(undefined); }
      } else plain.push(block);
    }
    const key = textOf(plain);
    if (!key || !images.length) continue;
    const candidate = { images, ...(paths.every(path => path !== undefined) ? { paths } : {}) };
    const old = byText.get(key);
    // Different images attached to identical prompt text are ambiguous and must not cross-match.
    byText.set(key, old === undefined ? candidate : JSON.stringify(old) === JSON.stringify(candidate) ? old : null);
  }
  return byText;
}

/** Admit existing local uploads and embedded images through the native attachment service. */
export async function prepareAttachments(snapshot, store, options = {}, signal, progress, onAttachment) {
  const summary = { images: 0, files: 0, missing: 0, found: 0, available: 0 };
  if (options.importAttachments === false) return summary;
  if (snapshot.mode === 'chatgpt') return prepareChatGPTAttachments(snapshot, store, options, signal, progress, onAttachment);
  const limit = options.maxAttachmentBytes ?? DEFAULT_LIMIT;
  const dryRun = options.dryRun !== false;
  const prepared = new Map(); const identities = []; const warnings = [];
  const fallback = rolloutImages(snapshot);
  const cache = new Map();
  let activeRecord;
  const copy = async (value, kind = 'auto', fallbackValue) => {
    signal?.throwIfAborted(); summary.found++;
    const key = digest([value, kind, fallbackValue]);
    let result;
    if (cache.has(key)) result = cache.get(key);
    else {
      try {
        const load = async candidate => {
          if (typeof candidate === 'string' && candidate.startsWith('data:')) return inlineImage(candidate, limit);
          const path = pathOf(candidate, snapshot.thread.cwd); const name = basename(path);
          let info;
          info = await stat(path);
          if (!info.isFile()) throw new Error('附件路径不是普通文件');
          if (info.size > limit) throw new Error('附件超过导入大小限制');
          let bytes, mediaType;
          if (kind === 'image' || IMAGE_TYPES.has(extname(path).toLowerCase())) {
            bytes = await readFile(path, { signal }); mediaType = imageType(bytes, path);
            if (bytes.length > limit) throw new Error('附件超过导入大小限制');
          }
          return { path, name, info, bytes, mediaType };
        };
        // Captured bytes represent the historical image and avoid expired or
        // privacy-restricted screenshot paths; never prefer a newer live file.
        const loaded = await load(fallbackValue || value);
        if (fallbackValue && typeof value === 'string' && !value.startsWith('data:')) loaded.name = basename(value);
        const { bytes, mediaType, path, name, info } = loaded;
        if (dryRun) {
          if (mediaType || kind === 'image') {
            if (!mediaType) throw new Error('无法识别图片格式');
            await store?.validateImage?.({ data: bytes, mediaType, name });
          }
          result = { type: mediaType || kind === 'image' ? 'image' : 'file', available: true };
        }
        else {
          if (!store) throw new Error('Harness 附件服务不可用');
          let attachment;
          if (mediaType || kind === 'image') {
            if (!mediaType) throw new Error('无法识别图片格式');
            attachment = await store.saveImage({ data: bytes, mediaType, name });
            result = { type: 'image', attachment };
          } else {
            let count = 0;
            async function* bounded() {
              for await (const chunk of createReadStream(path)) {
                signal?.throwIfAborted(); count += chunk.length;
                if (count > limit) throw new Error('附件超过导入大小限制');
                yield chunk;
              }
            }
            attachment = await store.saveFileStream({ data: bounded(), name, signal });
            result = { type: 'file', attachment, hostPath: store.fileHostPath(attachment) };
          }
          if (path) {
            const after = await stat(path);
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('复制过程中原附件发生变化，请重新导入');
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        const failure = attachmentFailure(error);
        const reason = failure.detail;
        const label = typeof value === 'string' && !value.startsWith('data:') ? basename(value) : '内嵌图片';
        result = { error: `[Codex 附件未导入：${label}；${reason}]`, failure };
      }
      cache.set(key, result);
    }
    if (result.error) { summary.missing++; warnings.push(result.error); }
    else { summary.available++; summary[result.type === 'image' ? 'images' : 'files']++; }
    if (onAttachment) {
      result.audit ||= auditSource(value, snapshot.thread.cwd, kind, result);
      const uncertain = result.audit.identity.startsWith('reference:') && !/^https?:/i.test(String(value));
      const entry = uncertain ? { ...result.audit, identity: result.audit.identity + ':' + digest([snapshot.thread.id, activeRecord?.key, summary.found]) } : result.audit;
      onAttachment(entry, snapshot.thread, activeRecord?.key);
    }
    progress?.(summary);
    return result;
  };

  for (const { record, projected } of projectedRecords(snapshot)) {
    signal?.throwIfAborted();
    if (!projected) continue;
    activeRecord = record;
    const original = messageContent(snapshot, record);
    let content, files = [];
    if (original) {
      content = [];
      const candidate = fallback.get(textOf(original));
      const originalImages = original.filter(block => ['localImage', 'image', 'input_image', 'image_url'].includes(block?.type));
      const recovery = candidate?.images.length === originalImages.length
        && (!candidate.paths || candidate.paths.every((path, i) => path === imageSource(originalImages[i]))) ? candidate.images : undefined;
      let imageIndex = 0;
      const seen = new Set(original.filter(block => ['localImage', 'image', 'input_image', 'image_url', 'file', 'localFile', 'input_file'].includes(block?.type)).map(imageSource));
      const appendAttachment = result => {
        if (result.error) content.push({ type: 'text', text: '\n\n' + result.error });
        else if (dryRun) content.push({ type: 'text', text: '[Codex 附件可导入]' });
        else if (result.type === 'file' && projected.role === 'assistant') files.push({ attachment: result.attachment, hostPath: result.hostPath });
        else content.push({ type: result.type, attachment: result.attachment });
      };
      for (const block of original) {
        const type = block?.type;
        if (['localImage', 'image', 'input_image', 'image_url'].includes(type)) {
          const value = imageSource(block); const alternate = recovery?.[imageIndex++];
          const result = await copy(value, 'image', alternate); seen.add(value);
          appendAttachment(result);
        } else if (['file', 'localFile', 'input_file'].includes(type)) {
          const result = await copy(block.path || block.file_path || block.url);
          appendAttachment(result);
        } else if (['text', 'input_text', 'output_text'].includes(type) || typeof block === 'string') {
          const value = typeof block === 'string' ? block : block.text || ''; content.push({ type: 'text', text: value });
          for (const file of mentionedFiles(value)) {
            if (seen.has(file.path)) continue; seen.add(file.path);
            const result = await copy(file.path);
            appendAttachment(result);
          }
        } else content.push({ type: 'text', text: `[Codex ${type || 'attachment'}]\n${JSON.stringify(block)}` });
      }
    } else if (record.item.type === 'imageView' || record.item.type === 'imageGeneration') {
      const value = record.item.path || record.item.savedPath;
      if (value) {
        const result = await copy(value, 'image');
        content = [...projected.content, result.error ? { type: 'text', text: result.error } : dryRun ? { type: 'text', text: '[Codex 图片可导入]' } : { type: 'image', attachment: result.attachment }];
      }
    }
    // Explicit generated download links, not bare project paths or code fences.
    if (projected.role === 'assistant' && record.item.type === 'agentMessage') {
      const value = record.item.text || '';
      for (const match of value.matchAll(/\[([^\]\n]+)\]\((?:<(\/[^>]+)>|(\/[^)\n]+))\)/g)) {
        if ((value.slice(0, match.index).match(/^\s*(?:```|~~~)/gm) || []).length % 2) continue;
        const path = match[2] || match[3];
        const location = /^(\/[\s\S]+?)(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)$/.exec(path);
        if (location) {
          const source = resolve(location[1]);
          onAttachment?.({ identity: 'path:' + source, source, name: basename(source), type: 'file', status: 'reference',
            detail: '代码位置跳转链接，不作为图片或文件附件复制。', location: path }, snapshot.thread, record.key);
          continue;
        }
        const result = await copy(path);
        content ||= [...projected.content];
        if (result.error) content.push({ type: 'text', text: result.error });
        else if (!dryRun && result.type === 'image') content.push({ type: 'image', attachment: result.attachment });
        else if (!dryRun) {
          files.push({ attachment: result.attachment, hostPath: result.hostPath });
          if (result.hostPath) content = content.map(block => block.type === 'text' ? { ...block, text: block.text.replace(match[0], `[${match[1]}](<${result.hostPath}>)`) } : block);
        }
      }
    }
    if (content) {
      const next = { ...projected, content, ...(files.length ? { files } : {}) };
      prepared.set(record.key, next);
      identities.push([record.key, next.content.filter(block => block.type !== 'text'), files, next.content.filter(block => block.type === 'text' && block.text.trimStart().startsWith('[Codex 附件未导入：'))]);
    }
  }
  if (summary.found) {
    snapshot.attachmentSummary = summary; snapshot.attachmentWarnings = [...new Set(warnings)];
    if (!dryRun) {
      snapshot.sourceFingerprint = snapshot.fingerprint;
      snapshot.fingerprint = digest({ source: snapshot.sourceFingerprint, attachmentFormat: 1, identities });
      snapshot.mediaMessages = prepared;
    }
  }
  return summary;
}
