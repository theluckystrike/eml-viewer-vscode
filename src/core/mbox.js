'use strict';
// Streams an MBOX file and builds an index of message byte ranges plus a few header fields.
// The whole file is never held in memory: it is read in chunks, and one message is read again by range when opened.
const { headerEnd, summarize } = require('./headers');

const CHUNK = 4 * 1024 * 1024;
const MAX_HEADER = 64 * 1024;
const FROM = Buffer.from('From ');

/** True when a "From " separator line starts at pos: at the file start, or after a blank line. */
function isSeparator(buf, pos, atFileStart) {
  if (buf[pos] !== 70 || buf[pos + 1] !== 114 || buf[pos + 2] !== 111 || buf[pos + 3] !== 109 || buf[pos + 4] !== 32) return false;
  if (atFileStart) return true;
  // previous line must be empty: "\n\n" or "\n\r\n" before pos
  if (pos >= 2 && buf[pos - 1] === 10 && buf[pos - 2] === 10) return true;
  if (pos >= 3 && buf[pos - 1] === 10 && buf[pos - 2] === 13 && buf[pos - 3] === 10) return true;
  return false;
}

/**
 * Index an MBOX source ({size, read(offset, length)}).
 * opts.onBatch(entries, scannedBytes) is called after each chunk with the new entries; opts.signal.aborted stops the scan.
 * Returns {entries, ms, aborted}. Each entry: {i, start, end, from, to, subject, date, attach, size}.
 */
async function indexMbox(src, opts = {}) {
  const t0 = Date.now();
  const chunkSize = opts.chunkSize || CHUNK;
  const entries = [];
  let pending = [];
  const starts = [];
  let pos = 0;
  // keep the last 8 bytes of the previous chunk so a separator cut by the chunk boundary, and the blank line before it, are found
  let tail = Buffer.alloc(0);
  if (src.size === 0) return { entries, ms: 0, aborted: false };
  while (pos < src.size) {
    if (opts.signal && opts.signal.aborted) return { entries, ms: Date.now() - t0, aborted: true };
    const chunk = await src.read(pos, chunkSize);
    if (!chunk.length) break;
    const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    const base = pos - tail.length;
    const newStarts = [];
    if (pos === 0 && isSeparator(buf, 0, true)) newStarts.push(0);
    let i = 0;
    while ((i = buf.indexOf(FROM, i + 1)) !== -1) {
      if (base + i <= (starts.length ? starts[starts.length - 1] : -1)) continue;
      if (buf.length - i < 5) break;
      if (isSeparator(buf, i, false)) newStarts.push(base + i);
    }
    for (const s of newStarts) {
      // close the message before this one
      if (starts.length) {
        const prev = entries[entries.length - 1];
        prev.end = trimEnd(buf, base, s);
      }
      starts.push(s);
      const e = { i: entries.length, start: s, end: src.size, from: '', to: '', subject: '', date: null, attach: false, size: 0 };
      // header block: from the line after "From ..." to the first blank line
      const local = s - base;
      const nl = buf.indexOf(10, local);
      let hdr = null;
      if (nl !== -1) {
        const he = headerEnd(buf, nl, Math.min(buf.length, nl + MAX_HEADER));
        if (he !== -1) hdr = buf.subarray(nl + 1, he).toString('latin1');
      }
      if (hdr === null) {
        const more = await src.read(s, MAX_HEADER);
        const nl2 = more.indexOf(10);
        const he2 = nl2 === -1 ? -1 : headerEnd(more, nl2);
        hdr = nl2 === -1 ? '' : more.subarray(nl2 + 1, he2 === -1 ? more.length : he2).toString('latin1');
      }
      Object.assign(e, summarize(utf8IfValid(hdr)));
      entries.push(e);
      pending.push(e);
    }
    pos += chunk.length;
    tail = buf.subarray(Math.max(0, buf.length - 8));
    tail = Buffer.from(tail);
    if (opts.onBatch && pending.length) { await opts.onBatch(pending, pos); pending = []; }
    else if (opts.onBatch) await opts.onBatch([], pos);
  }
  for (const e of entries) e.size = e.end - e.start;
  if (!entries.length) {
    // not an mbox: treat the whole file as one message so a single message saved as .mbox still opens
    entries.push({ i: 0, start: 0, end: src.size, size: src.size, single: true, ...summarize(utf8IfValid((await src.read(0, MAX_HEADER)).toString('latin1').split(/\r?\n\r?\n/)[0])) });
  }
  return { entries, ms: Date.now() - t0, aborted: false };
}

/** End offset of the previous message: drop the blank separator line before the next "From ". */
function trimEnd(buf, base, nextStart) {
  let e = nextStart;
  const local = nextStart - base;
  if (local >= 1 && buf[local - 1] === 10) { e--; if (local >= 2 && buf[local - 2] === 13) e--; }
  return e;
}

/** Header text is read as latin1 bytes; turn it into UTF-8 when the bytes are valid UTF-8 (raw 8-bit headers). */
function utf8IfValid(latin1) {
  if (!/[\x80-\xff]/.test(latin1)) return latin1;
  const b = Buffer.from(latin1, 'latin1');
  const s = b.toString('utf8');
  return s.includes('�') ? latin1 : s;
}

/** The message bytes of one entry: without the "From " line, with mboxrd ">From " quoting removed. */
function unwrapMessage(bytes, single) {
  let b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!single && b.subarray(0, 5).equals(FROM)) {
    const nl = b.indexOf(10);
    b = nl === -1 ? Buffer.alloc(0) : b.subarray(nl + 1);
  }
  return unquoteFrom(b);
}

/** Removes one '>' from lines that match /^>+From / (mboxrd). Returns the same buffer when nothing is quoted. */
function unquoteFrom(b) {
  const re = />+From /;
  if (!re.test(b.toString('latin1'))) return b;
  const parts = [];
  let last = 0;
  let lineStart = 0;
  for (let i = 0; i <= b.length; i++) {
    if (i === b.length || b[i] === 10) {
      // line is b[lineStart, i)
      let j = lineStart;
      while (j < i && b[j] === 62) j++;
      if (j > lineStart && i - j >= 5 && b[j] === 70 && b[j + 1] === 114 && b[j + 2] === 111 && b[j + 3] === 109 && b[j + 4] === 32) {
        parts.push(b.subarray(last, lineStart));
        last = lineStart + 1;
      }
      lineStart = i + 1;
    }
  }
  parts.push(b.subarray(last));
  return Buffer.concat(parts);
}

/** Apple Mail .emlx: first line is the byte count of the message, then the message, then an XML plist. */
function unwrapEmlx(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nl = b.indexOf(10);
  if (nl > 0 && nl < 20) {
    const n = parseInt(b.subarray(0, nl).toString('latin1').trim(), 10);
    if (Number.isFinite(n) && n > 0) return b.subarray(nl + 1, Math.min(b.length, nl + 1 + n));
  }
  return b;
}

// ---- list queries over the index ----

const SORTS = ['file', 'date', 'from', 'subject', 'size'];

/** Filter and sort the index. Returns an array of entry numbers. */
function queryIndex(entries, { query = '', sort = 'file', desc = false } = {}) {
  const q = String(query).trim().toLowerCase();
  let ids = [];
  if (!q) ids = entries.map((_, i) => i);
  else {
    const words = q.split(/\s+/).slice(0, 8);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const hay = `${e.from}\n${e.to}\n${e.subject}`.toLowerCase();
      if (words.every(w => hay.includes(w))) ids.push(i);
    }
  }
  if (sort !== 'file' && SORTS.includes(sort)) {
    const key = sort === 'date' ? (e => (e.date === null ? -Infinity : e.date)) : sort === 'size' ? (e => e.size) : (e => String(e[sort]).toLowerCase());
    const coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    ids.sort((a, b) => {
      const ka = key(entries[a]), kb = key(entries[b]);
      const c = typeof ka === 'number' ? ka - kb : coll.compare(ka, kb);
      return c || a - b;
    });
  }
  if (desc) ids.reverse();
  return ids;
}

module.exports = { indexMbox, unwrapMessage, unwrapEmlx, unquoteFrom, queryIndex, isSeparator, SORTS, CHUNK };
