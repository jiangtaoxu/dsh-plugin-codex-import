import { StringDecoder } from 'node:string_decoder';

export async function* jsonlLines(chunks) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of chunks) {
    pending += decoder.write(chunk);
    let start = 0, end;
    // JSON permits literal U+2028/U+2029 inside strings; only LF ends a JSONL row.
    while ((end = pending.indexOf('\n', start)) !== -1) {
      yield pending.slice(start, end); start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  if (pending) yield pending;
}
