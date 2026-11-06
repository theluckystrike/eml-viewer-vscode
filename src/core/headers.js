'use strict';
// Header helpers that do not need the full MIME parser: a fast header block reader for the MBOX index,
// authentication results (SPF, DKIM, DMARC, ARC) and the Received hops.
const { decodeWords, addressParser } = require('./mime-lib');

/** Splits a raw header block (string) into [{key, name, value}] with folded lines joined. */
function splitHeaders(block) {
  const out = [];
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1].value += ' ' + line.trim(); continue; }
    const m = /^([^:\s][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    out.push({ key: m[1].toLowerCase(), name: m[1], value: m[2] });
  }
  return out;
}

/** Finds the end of the header block in a byte buffer. Returns the index of the blank line, or -1. */
function headerEnd(buf, start = 0, max = buf.length) {
  const lim = Math.min(buf.length, max);
  for (let i = start; i < lim - 1; i++) {
    if (buf[i] !== 10) continue;
    if (buf[i + 1] === 10) return i + 1;
    if (buf[i + 1] === 13 && buf[i + 2] === 10) return i + 1;
  }
  return -1;
}

function safeDecode(s) {
  try { return decodeWords(s); } catch { return s; }
}

function addrText(value) {
  if (!value) return '';
  let list;
  try { list = addressParser(value); } catch { return safeDecode(value); }
  const parts = [];
  const walk = a => {
    if (a.group) { a.group.forEach(walk); return; }
    const name = safeDecode(a.name || '');
    parts.push(name ? name : a.address || '');
  };
  list.forEach(walk);
  return parts.filter(Boolean).join(', ') || safeDecode(value);
}

function addrList(value) {
  if (!value) return [];
  let list;
  try { list = addressParser(value); } catch { return [{ name: safeDecode(value), address: '' }]; }
  const out = [];
  const walk = a => { if (a.group) a.group.forEach(walk); else out.push({ name: safeDecode(a.name || ''), address: a.address || '' }); };
  list.forEach(walk);
  return out;
}

function parseDate(v) {
  if (!v) return null;
  const t = Date.parse(v.replace(/\([^)]*\)/g, '').trim());
  return Number.isFinite(t) ? t : null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The summary fields of one MBOX message, from its header block. */
function summarize(block) {
  const h = splitHeaders(block);
  const get = k => { const e = h.find(x => x.key === k); return e ? e.value : ''; };
  const ct = get('content-type').toLowerCase();
  return {
    from: clip(addrText(get('from')), 200),
    to: clip(addrText(get('to')), 200),
    subject: clip(safeDecode(get('subject')).replace(/\s+/g, ' ').trim(), 300),
    date: parseDate(get('date')),
    attach: /multipart\/mixed/.test(ct),
  };
}

// ---- Authentication results ----

function stripComments(s) {
  let out = '', depth = 0;
  for (const ch of s) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')' && depth) { depth--; continue; }
    if (!depth) out += ch;
  }
  return out;
}

/** Splits on ';' outside quotes and comments. */
function splitSemis(s) {
  const out = []; let cur = '', depth = 0, q = false;
  for (const ch of s) {
    if (ch === '"' && !depth) q = !q;
    else if (!q && ch === '(') depth++;
    else if (!q && ch === ')' && depth) depth--;
    if (ch === ';' && !q && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** Parses one Authentication-Results value (RFC 8601). */
function parseAuthResultsValue(value) {
  const parts = splitSemis(value);
  if (!parts.length) return null;
  const first = stripComments(parts[0]).trim().split(/\s+/);
  let serv = first[0] || '';
  const results = [];
  let rest = parts.slice(1);
  // Some servers put the first result on the same segment as the authserv-id: "mx.example.com; spf=pass" is normal, but
  // "i=1; mx.example.com; spf=pass" is ARC: drop the instance tag.
  if (/^i=\d+$/i.test(serv) && rest.length) { serv = stripComments(rest[0]).trim().split(/\s+/)[0]; rest = rest.slice(1); }
  if (/=/.test(serv)) { rest = parts; serv = ''; }
  for (const seg of rest) {
    const comment = (seg.match(/\(([^)]*)\)/) || [])[1] || '';
    const flat = stripComments(seg).trim();
    const m = /^([a-z0-9_.-]+)\s*=\s*([a-z0-9_-]+)/i.exec(flat);
    if (!m) continue;
    const props = {};
    for (const p of flat.slice(m[0].length).matchAll(/([a-z0-9_.-]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)) props[p[1].toLowerCase()] = p[2].replace(/^"|"$/g, '');
    results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props, comment: comment.trim() });
  }
  if (/^none$/i.test(rest.join('').trim())) return { serv, results: [] };
  return { serv, results };
}

function tagList(value) {
  const t = {};
  for (const m of value.matchAll(/(?:^|;)\s*([a-z]+)\s*=\s*([^;]*)/gi)) t[m[1].toLowerCase()] = m[2].replace(/\s+/g, '');
  return t;
}

const RANK = { pass: 0, bestguesspass: 1, neutral: 2, none: 3, policy: 4, softfail: 5, temperror: 6, permerror: 7, fail: 8 };

/** Authentication facts from the message headers ([{key, value}], top first). */
function authInfo(headers) {
  const ar = headers.filter(h => h.key === 'authentication-results').map(h => parseAuthResultsValue(h.value)).filter(Boolean);
  const arc = headers.filter(h => h.key === 'arc-authentication-results').map(h => parseAuthResultsValue(h.value)).filter(Boolean);
  const spfHdr = headers.filter(h => h.key === 'received-spf').map(h => {
    const m = /^\s*([a-z]+)/i.exec(h.value);
    return { result: m ? m[1].toLowerCase() : '', text: h.value.slice(0, 400) };
  });
  const dkimSigs = headers.filter(h => h.key === 'dkim-signature').map(h => {
    const t = tagList(h.value);
    return { d: t.d || '', s: t.s || '', a: t.a || '', h: (t.h || '').split(':').filter(Boolean).length };
  });
  const arcSeals = headers.filter(h => h.key === 'arc-seal').map(h => { const t = tagList(h.value); return { i: Number(t.i) || 0, cv: (t.cv || '').toLowerCase(), d: t.d || '' }; });
  const top = ar[0] || null;
  const pick = method => {
    if (!top) return null;
    const rs = top.results.filter(r => r.method === method);
    if (!rs.length) return null;
    // with several DKIM signatures, show the best one and list the rest
    rs.sort((a, b) => (RANK[a.result] ?? 9) - (RANK[b.result] ?? 9));
    return rs[0];
  };
  let spf = pick('spf');
  if (!spf && spfHdr.length) spf = { method: 'spf', result: spfHdr[0].result, props: {}, comment: 'from Received-SPF' };
  const summary = { spf, dkim: pick('dkim'), dmarc: pick('dmarc'), arc: pick('arc') };
  return { summary, results: ar, arc, receivedSpf: spfHdr, dkimSignatures: dkimSigs, arcSeals, verified: false };
}

// ---- Received hops ----

/** Parses one Received header value. */
function parseReceived(value) {
  const v = value.replace(/\s+/g, ' ').trim();
  const semi = v.lastIndexOf(';');
  const body = semi >= 0 ? v.slice(0, semi) : v;
  const dateText = semi >= 0 ? v.slice(semi + 1).trim() : '';
  const field = name => {
    const re = new RegExp(`(?:^|\\s)${name}\\s+(.+?)(?=\\s(?:from|by|via|with|id|for)\\s|$)`, 'i');
    const m = re.exec(body);
    return m ? m[1].trim() : '';
  };
  const from = field('from');
  const ipm = /\[(?:IPv6:)?([0-9a-f:.]+)\]/i.exec(from) || /\(([0-9]{1,3}(?:\.[0-9]{1,3}){3})\)/.exec(from);
  const fromHost = from.replace(/\(.*$/, '').trim().split(/\s/)[0] || '';
  const by = field('by').replace(/\(.*$/, '').trim().split(/\s/)[0] || '';
  const withProto = field('with').split(/\s/)[0] || '';
  const tls = /\b(TLS|ESMTPS|ESMTPSA|cipher=|version=TLS)/i.test(v);
  return { from: fromHost, fromRaw: from.slice(0, 300), ip: ipm ? ipm[1] : '', by, with: withProto, id: field('id').split(/\s/)[0] || '', tls, date: parseDate(dateText), dateText: dateText.slice(0, 80), raw: value.slice(0, 600) };
}

/** Hops oldest first, each with the delay after the hop before it (seconds, or null). */
function receivedHops(headers) {
  const hops = headers.filter(h => h.key === 'received').map(h => parseReceived(h.value)).reverse();
  let prev = null;
  for (const h of hops) {
    h.delay = (prev !== null && h.date !== null) ? Math.round((h.date - prev) / 1000) : null;
    if (h.date !== null) prev = h.date;
  }
  return hops;
}

module.exports = { splitHeaders, headerEnd, summarize, addrText, addrList, parseDate, parseAuthResultsValue, authInfo, parseReceived, receivedHops, safeDecode, stripComments };
