'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, safeFileName } = require('../src/core/message');
const samples = require('../scripts/make-samples');
const buf = s => Buffer.from(s, 'utf8');

test('newsletter: header card, html and text, cid images, attachments, auth, hops', async () => {
  const { model, attachments } = await parseMessage(buf(samples.newsletter()));
  assert.equal(model.subject, 'October product update: faster dashboards and team spaces');
  assert.deepEqual(model.from, [{ name: 'Northwind Labs', address: 'news@example.com' }]);
  assert.equal(model.replyTo[0].address, 'support@example.com');
  assert.match(model.html, /cid:logo@example.com/);
  assert.match(model.text, /Faster dashboards/);
  assert.deepEqual(Object.keys(model.cid).sort(), ['chart@example.com', 'logo@example.com']);
  assert.match(model.cid['logo@example.com'], /^data:image\/png;base64,iVBOR/);
  assert.deepEqual(model.attachments.map(a => [a.filename, a.inline]), [['logo.png', true], ['chart.png', true], ['signups-2026.csv', false], ['release-notes-october.pdf', false]]);
  assert.equal(Buffer.from(attachments[2].content).toString(), 'month,signups,churn\n2026-05,1204,2.1\n2026-06,1388,1.9\n2026-07,1502,2.4\n2026-08,1710,1.7\n2026-09,1835,1.6\n');
  assert.ok(!('content' in model.attachments[0]), 'attachment bytes stay in the host');
  assert.deepEqual([model.auth.summary.spf.result, model.auth.summary.dkim.result, model.auth.summary.dmarc.result], ['pass', 'pass', 'pass']);
  assert.equal(model.hops.length, 4);
  assert.deepEqual(model.hops.map(h => h.delay), [null, 2, 1, 4]);
  assert.equal(model.rawTruncated, false);
});

test('spoofed invoice: fail results and a Reply-To that differs', async () => {
  const { model } = await parseMessage(buf(samples.spoofed()));
  assert.equal(model.auth.summary.spf.result, 'fail');
  assert.equal(model.auth.summary.dkim.result, 'none');
  assert.equal(model.auth.summary.dmarc.result, 'fail');
  assert.equal(model.replyTo[0].address, 'payments-desk@example.net');
  assert.equal(model.hops[1].delay, 540);
  assert.equal(model.html, '');
});

test('encoded words, quoted-printable UTF-8 and calendar attachments', async () => {
  const { model } = await parseMessage(buf(samples.encoded()));
  assert.equal(model.subject, 'Résumé de la réunion – 東京 & Zürich');
  assert.equal(model.cc[0].name, '田中 花子');
  assert.match(model.text, /東京オフィス/);
  assert.equal(model.attachments[0].filename, 'reunion.ics');
});

test('the unsafe sample keeps its HTML for the sandbox and its subject as plain text', async () => {
  const { model } = await parseMessage(buf(samples.hostile()));
  assert.equal(model.subject, '<img src=x onerror=alert(1)> unsafe HTML test');
  assert.match(model.html, /<script>/, 'the host does not touch the HTML; the webview sanitizes it and the sandbox blocks scripts');
});

test('attachment names cannot carry paths, control or bidi characters', () => {
  assert.equal(safeFileName('../../etc/passwd', 'x'), 'passwd');
  assert.equal(safeFileName('..\\..\\boot.ini', 'x'), 'boot.ini');
  assert.equal(safeFileName('invoice‮gnp.exe', 'x'), 'invoicegnp.exe');
  assert.equal(safeFileName('a<b>:c?.txt', 'x'), 'a_b__c_.txt');
  assert.equal(safeFileName('', 'attachment-1.bin'), 'attachment-1.bin');
  assert.equal(safeFileName('...', 'f'), 'f');
  assert.ok(safeFileName('a'.repeat(300) + '.pdf', 'x').length <= 120);
});

test('raw source is capped and broken input still parses', async () => {
  const big = 'Subject: big\r\n\r\n' + 'x'.repeat(3 * 1024 * 1024);
  const { model } = await parseMessage(buf(big));
  assert.equal(model.rawTruncated, true);
  assert.equal(model.raw.length, 2 * 1024 * 1024);
  const odd = await parseMessage(buf('no headers at all, just text'));
  assert.equal(odd.model.subject, '');
  const nested = await parseMessage(buf('Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: text/plain\r\n\r\nhi\r\n'));
  assert.match(nested.model.text, /hi/);
});
