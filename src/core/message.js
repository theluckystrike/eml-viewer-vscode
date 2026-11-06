'use strict';
// Turns raw message bytes into the view model the webview shows. Runs in the extension host.
const { PostalMime } = require('./mime-lib');
const { authInfo, receivedHops, safeDecode } = require('./headers');

const RAW_SHOW = 2 * 1024 * 1024;        // raw source shown in the Source tab
const INLINE_MAX = 8 * 1024 * 1024;      // total bytes of cid images sent to the webview
const HEADER_ROWS = 400;

/** A file name that is safe to show and to offer in a save dialog. */
function safeFileName(name, fallback) {
  let n = String(name || '').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '');
  n = n.split(/[\\/]/).pop().replace(/^\.+/, '').replace(/[<>:"|?*]/g, '_').trim();
  if (!n) n = fallback;
  return n.length > 120 ? n.slice(0, 80) + '…' + n.slice(-30) : n;
}

const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/calendar': 'ics', 'message/rfc822': 'eml', 'text/html': 'html' };

function fmtAddress(a) {
  if (!a) return [];
  if (Array.isArray(a)) return a.flatMap(fmtAddress);
  if (a.group) return a.group.flatMap(fmtAddress);
  return [{ name: a.name || '', address: a.address || '' }];
}

function cidKey(cid) { return String(cid || '').trim().replace(/^<|>$/g, '').toLowerCase(); }

/** Text for the Source tab: UTF-8 when the bytes are valid UTF-8, else latin1. */
function rawText(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, RAW_SHOW));
  const s = b.toString('utf8');
  return s.includes('�') ? b.toString('latin1') : s;
}

/**
 * Parse one message. Returns {model, attachments} where model is sent to the webview and attachments
 * (with content) stay in the host for "Save".
 */
async function parseMessage(bytes, opts = {}) {
  const t0 = Date.now();
  const email = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 64, rfc822Attachments: true });
  const headers = (email.headers || []).map(h => ({ key: h.key, name: h.originalKey || h.key, value: h.value }));
  const html = email.html || '';
  const atts = (email.attachments || []).map((a, i) => {
    const size = a.content ? a.content.byteLength : 0;
    const type = String(a.mimeType || 'application/octet-stream').replace(/[^\w.+\-/]/g, '').slice(0, 100) || 'application/octet-stream';
    const ext = EXT_BY_TYPE[type] || 'bin';
    return { i, filename: safeFileName(a.filename && safeDecode(a.filename), `attachment-${i + 1}.${ext}`), mimeType: type, size,
      disposition: a.disposition || '', contentId: a.contentId ? cidKey(a.contentId) : '', content: a.content };
  });
  // inline images referenced by cid: in the HTML go to the webview as data URLs
  const cid = {};
  let inlineBytes = 0;
  const lowerHtml = html.toLowerCase();
  for (const a of atts) {
    if (!a.contentId || !/^image\//.test(a.mimeType)) continue;
    a.referenced = lowerHtml.includes('cid:' + a.contentId);
    if (!a.referenced || inlineBytes + a.size > INLINE_MAX) continue;
    inlineBytes += a.size;
    cid[a.contentId] = `data:${a.mimeType};base64,${Buffer.from(a.content).toString('base64')}`;
  }
  const model = {
    subject: email.subject ? String(email.subject) : '',
    from: fmtAddress(email.from),
    sender: fmtAddress(email.sender),
    to: fmtAddress(email.to),
    cc: fmtAddress(email.cc),
    bcc: fmtAddress(email.bcc),
    replyTo: fmtAddress(email.replyTo),
    date: email.date || '',
    dateMs: email.date ? (Number.isFinite(Date.parse(email.date)) ? Date.parse(email.date) : null) : null,
    messageId: email.messageId || '',
    html,
    text: email.text || '',
    headers: headers.slice(0, HEADER_ROWS).map(h => ({ name: h.name, value: h.value.length > 4000 ? h.value.slice(0, 4000) + '…' : h.value })),
    headerCount: headers.length,
    attachments: atts.map(a => ({ i: a.i, filename: a.filename, mimeType: a.mimeType, size: a.size, inline: !!a.referenced, contentId: a.contentId })),
    cid,
    auth: authInfo(headers),
    hops: receivedHops(headers),
    raw: rawText(bytes),
    rawSize: bytes.byteLength,
    rawTruncated: bytes.byteLength > RAW_SHOW,
    parseMs: Date.now() - t0,
    source: opts.source || '',
  };
  return { model, attachments: atts };
}

module.exports = { parseMessage, safeFileName, fmtAddress, cidKey, RAW_SHOW, INLINE_MAX };
