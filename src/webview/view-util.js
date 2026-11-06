'use strict';
// Pure helpers for the webview, kept apart so the tests can run them in Node.

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

function addr(a) {
  if (!a) return '';
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.name || a.address || '';
}

function addrs(list) { return (list || []).map(addr).filter(Boolean).join(', '); }

const pad = n => String(n).padStart(2, '0');

/** Short local date for the list: "2026-10-04 09:12". */
function shortDate(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Delay between hops: "+0 s", "+42 s", "+3 min 5 s", "+2 h 4 min", or a warning for clocks that go back. */
function fmtDelay(s) {
  if (s === null || s === undefined) return '';
  if (s < 0) return `${s} s (clock skew)`;
  if (s < 60) return `+${s} s`;
  if (s < 3600) return `+${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `+${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `+${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** Badge class for an auth result. */
function resultClass(r) {
  if (!r) return 'none';
  if (r === 'pass' || r === 'bestguesspass') return 'pass';
  if (r === 'fail' || r === 'permerror' || r === 'softfail') return 'fail';
  return 'neutral';
}

/** The detail line under an auth badge: "smtp.mailfrom=example.com", "header.d=example.com", "p=REJECT". */
function authDetail(r) {
  if (!r) return 'not recorded';
  const p = r.props || {};
  if (r.method === 'spf') return p['smtp.mailfrom'] || p['smtp.helo'] || r.comment || '';
  if (r.method === 'dkim') return [p['header.d'] || p['header.i'], p['header.s'] ? `s=${p['header.s']}` : ''].filter(Boolean).join(' ');
  if (r.method === 'dmarc') return [p['header.from'], (r.comment.match(/p=\w+/i) || [])[0]].filter(Boolean).join(' ');
  return Object.entries(p).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(' ');
}

const SORT_OPTIONS = [
  ['file', false, 'File order'],
  ['date', true, 'Newest first'],
  ['date', false, 'Oldest first'],
  ['from', false, 'Sender A-Z'],
  ['subject', false, 'Subject A-Z'],
  ['size', true, 'Largest first'],
];

/** Plain text of an HTML body (for messages that have no text part). */
function htmlToText(html, parse) {
  const doc = parse(String(html || '').replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)\b[^>]*>/gi, m => m + '\n'));
  for (const el of [...doc.querySelectorAll('script,style,head,title')]) el.remove();
  return (doc.body ? doc.body.textContent : '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { fmtSize, addr, addrs, shortDate, fmtDelay, resultClass, authDetail, htmlToText, SORT_OPTIONS };
