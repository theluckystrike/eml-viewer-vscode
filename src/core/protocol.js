'use strict';
// Message protocol between the extension host and the webview, plus size rules. No vscode import, so tests run in Node.
const MB = 1024 * 1024;
const GB = 1024 * MB;
const HARD_LIMIT = 4 * GB;
const PAGE_MAX = 500;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < GB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

/** What to do with a file of this size. kind is 'eml' or 'mbox'. */
function sizePlan(size, kind, maxMessageMB) {
  if (size > HARD_LIMIT) {
    return { open: false, message: `This file is ${fmtSize(size)}. EML Viewer opens files up to 4 GB so VS Code stays responsive. Split the mailbox into smaller files, or open it as text.` };
  }
  if (kind !== 'mbox' && size > maxMessageMB * MB) {
    return { open: false, message: `This message is ${fmtSize(size)}. EML Viewer parses messages up to ${maxMessageMB} MB (setting emlViewer.maxMessageMB). Open it as text instead.` };
  }
  return { open: true };
}

function kindOf(name) {
  const n = String(name).toLowerCase();
  if (/\.(mbox|mbx)$/.test(n)) return 'mbox';
  if (/\.emlx$/.test(n)) return 'emlx';
  return 'eml';
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** The list and tab state the webview hands back to itself across a reload (remote images on or off). */
function cleanUi(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    query: isStr(u.query, 300) ? u.query : '',
    sort: ['file', 'date', 'from', 'subject', 'size'].includes(u.sort) ? u.sort : 'file',
    desc: !!u.desc,
    offset: isInt(u.offset, 0, 1e8) ? u.offset : 0,
    tab: ['html', 'text', 'source', 'auth', 'route', 'headers'].includes(u.tab) ? u.tab : 'html',
  };
}

/** Accepts only the messages the webview is meant to send. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready': case 'openText': case 'rendered':
      return { ok: true, msg: { type: m.type } };
    case 'showImages': case 'blockImages':
      return { ok: true, msg: { type: m.type, ui: cleanUi(m.ui) } };
    case 'open':
      return isInt(m.index, 0, 1e8) ? { ok: true, msg: { type: 'open', index: m.index } } : { ok: false };
    case 'page': {
      const sort = ['file', 'date', 'from', 'subject', 'size'].includes(m.sort) ? m.sort : 'file';
      if (!isInt(m.offset, 0, 1e8) || !isInt(m.limit, 1, PAGE_MAX) || !isStr(m.query || '', 300) || !isInt(m.req, 0, 1e9)) return { ok: false };
      return { ok: true, msg: { type: 'page', offset: m.offset, limit: m.limit, query: m.query || '', sort, desc: !!m.desc, req: m.req } };
    }
    case 'save':
      return isInt(m.att, 0, 10000) ? { ok: true, msg: { type: 'save', att: m.att } } : { ok: false };
    case 'openLink':
      return isStr(m.url, 4096) && /^(https?:|mailto:)/i.test(m.url) ? { ok: true, msg: { type: 'openLink', url: m.url } } : { ok: false };
    case 'copy':
      return isStr(m.text, 2 * MB) ? { ok: true, msg: { type: 'copy', text: m.text } } : { ok: false };
    default:
      return { ok: false };
  }
}

/** One page of list rows for the webview. */
function pageRows(entries, ids, offset, limit) {
  return ids.slice(offset, offset + limit).map(i => {
    const e = entries[i];
    return { i, from: e.from, to: e.to, subject: e.subject, date: e.date, size: e.size, attach: !!e.attach };
  });
}

module.exports = { cleanUi, fmtSize, sizePlan, kindOf, validateWebviewMessage, pageRows, MB, GB, HARD_LIMIT, PAGE_MAX };
