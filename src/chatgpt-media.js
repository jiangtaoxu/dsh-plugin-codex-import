import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { digest } from './source.js';
import { chatGPTRecords } from './chatgpt-source.js';

function mediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', '.png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', '.jpg'];
  if (bytes.subarray(0, 3).toString() === 'GIF') return ['image/gif', '.gif'];
  if (bytes.subarray(0, 4).toString() === 'RIFF') {
    if (bytes.subarray(8, 12).toString() === 'WEBP') return ['image/webp', '.webp'];
    if (bytes.subarray(8, 12).toString() === 'WAVE') return ['audio/wav', '.wav'];
  }
  if (bytes.subarray(0, 4).toString() === '%PDF') return ['application/pdf', '.pdf'];
  return [];
}

/** Resolve only archive members; never interpret an exported pointer as a host path. */
export async function prepareChatGPTAttachments(snapshot, store, options = {}, signal, progress, onAttachment) {
  const summary = { images: 0, files: 0, missing: 0, found: 0, available: 0 };
  const dryRun = options.dryRun !== false, limit = options.maxAttachmentBytes ?? 100 * 1024 ** 2;
  const cache = new Map(), prepared = new Map(), identities = [], warnings = [];
  for (const { record, projected } of chatGPTRecords(snapshot)) {
    if (!projected?.assets?.length) continue;
    const content = [...projected.content], files = [];
    for (const asset of projected.assets) {
      signal?.throwIfAborted(); summary.found++;
      const key = digest([asset.pointer, asset.name, asset.kind, asset.mimeType]);
      let result = cache.get(key);
      if (!result) {
        let resolved;
        try {
          resolved = snapshot.resolveAsset(asset);
          const bytes = await snapshot.archive.bytes(resolved.entry, signal, limit);
          const [detected, extension] = mediaType(bytes);
          const mimeType = detected || resolved.mimeType;
          let name = resolved.name;
          if ((!extname(name) || extname(name) === '.dat') && extension) name = name.replace(/\.dat$/, '') + extension;
          const image = asset.kind === 'image' || mimeType?.startsWith('image/');
          if (image && !detected?.startsWith('image/')) throw new Error('无法识别图片格式');
          const hash = createHash('sha256').update(bytes).digest('hex');
          result = { type: image ? 'image' : 'file', name, entry: resolved.entry, identity: digest([hash, name]) };
          if (dryRun) {
            if (image) await store?.validateImage?.({ data: bytes, mediaType: mimeType, name });
          } else {
            if (!store) throw new Error('Harness 附件服务不可用');
            if (image) result.attachment = await store.saveImage({ data: bytes, mediaType: mimeType, name });
            else {
              result.attachment = await store.saveFileStream({ data: (async function* () { yield bytes; })(), name, signal });
              result.hostPath = store.fileHostPath(result.attachment);
            }
          }
        } catch (error) {
          signal?.throwIfAborted();
          const code = error.code === 'ENOENT' ? 'missing' : /大小限制|size limit|TOO_LARGE|TOO_MANY_PIXELS/.test(error.message + error.code) ? 'too-large'
            : /图片格式|INVALID_IMAGE/.test(error.message + error.code) ? 'format' : /远程/.test(error.message) ? 'remote' : /发生变化/.test(error.message) ? 'changed' : /服务不可用/.test(error.message) ? 'service' : 'other';
          result = { type: asset.kind === 'image' ? 'image' : 'file', name: asset.name || resolved?.name || asset.pointer,
            entry: resolved?.entry, identity: digest([asset.pointer, code]), reasonCode: code, detail: error.message,
            error: `[ChatGPT 附件未导入：${asset.name || resolved?.name || asset.pointer}；${error.message}]` };
        }
        cache.set(key, result);
      }
      identities.push([record.key, asset.pointer, result.identity]);
      onAttachment?.({ identity: `${snapshot.source.sourceId}:${result.entry || asset.pointer}`, source: result.entry || asset.pointer,
        name: result.name, type: result.type, reasonCode: result.reasonCode, detail: result.detail }, snapshot.thread, record.key);
      if (result.error) {
        summary.missing++; warnings.push(result.error); content[asset.index] = { type: 'text', text: result.error };
      } else {
        summary.available++; summary[result.type === 'image' ? 'images' : 'files']++;
        if (!dryRun && result.type === 'file' && projected.role === 'assistant') {
          files.push({ attachment: result.attachment, hostPath: result.hostPath });
          content[asset.index] = { type: 'text', text: `[ChatGPT 附件：${result.name}]` };
        } else if (!dryRun) content[asset.index] = { type: result.type, attachment: result.attachment };
      }
      progress?.(summary);
    }
    prepared.set(record.key, { ...projected, content, ...(files.length ? { files } : {}) });
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
