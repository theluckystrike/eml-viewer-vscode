'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../src/core/mbox');
const { BufferSource, FileSource } = require('../src/core/source');
const samples = require('../scripts/make-samples');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emlv-mbox-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const src = s => new BufferSource(Buffer.from(s, 'latin1'));

test('index finds From_ lines only at the file start or after a blank line', async () => {
  const box = 'From a@example.com Mon Jan  6 09:00:00 2025\nFrom: A <a@example.com>\nSubject: one\n\nbody\nFrom here on, not a separator\n\nFrom b@example.com Mon Jan  6 10:00:00 2025\nFrom: B <b@example.com>\nSubject: two\n\nbody two\n';
  const r = await M.indexMbox(src(box));
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map(e => e.subject), ['one', 'two']);
  const first = Buffer.from(box, 'latin1').subarray(r.entries[0].start, r.entries[0].end).toString('latin1');
  assert.ok(first.endsWith('not a separator\n'), 'blank separator line is not part of the message');
  assert.equal(r.entries[1].end, box.length);
});

test('CRLF mailboxes and the same result for every chunk size', async () => {
  const box = samples.mbox(300, Date.UTC(2025, 0, 1));
  const crlf = box.replace(/\n/g, '\r\n');
  const ref = await M.indexMbox(src(box));
  assert.equal(ref.entries.length, 300);
  for (const cs of [64, 997, 4096, 65536]) {
    const r = await M.indexMbox(src(box), { chunkSize: cs });
    assert.deepEqual(r.entries.map(e => [e.start, e.end, e.subject]), ref.entries.map(e => [e.start, e.end, e.subject]), `chunk ${cs}`);
  }
  const r2 = await M.indexMbox(src(crlf), { chunkSize: 1000 });
  assert.equal(r2.entries.length, 300);
  assert.deepEqual(r2.entries.map(e => e.subject), ref.entries.map(e => e.subject));
});

test('mboxrd quoting: >From loses one > and the From_ line is dropped', () => {
  const raw = Buffer.from('From x@example.com Mon Jan  6 09:00:00 2025\nSubject: q\n\n>From the notes\n>>From older\nFromage is cheese\n');
  assert.equal(M.unwrapMessage(raw).toString(), 'Subject: q\n\nFrom the notes\n>From older\nFromage is cheese\n');
  assert.equal(M.unquoteFrom(Buffer.from('a\nb\n')).toString(), 'a\nb\n');
});

test('a file with no From_ line opens as one message; empty file has none', async () => {
  const r = await M.indexMbox(src('Subject: alone\nFrom: a@example.com\n\nhi\n'));
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].single, true);
  assert.equal(r.entries[0].subject, 'alone');
  assert.equal(M.unwrapMessage(Buffer.from('Subject: alone\n\nhi\n'), true).toString(), 'Subject: alone\n\nhi\n');
  assert.equal((await M.indexMbox(src(''))).entries.length, 0);
});

test('indexing stops when the panel closes (signal) and reports batches', async () => {
  const box = samples.mbox(200, Date.UTC(2025, 0, 1));
  const signal = { aborted: false };
  let batches = 0;
  const r = await M.indexMbox(src(box), { chunkSize: 2048, signal, onBatch: () => { if (++batches === 3) signal.aborted = true; } });
  assert.equal(r.aborted, true);
  assert.ok(r.entries.length > 0 && r.entries.length < 200);
});

test('emlx: byte count line, message, then plist', () => {
  const b = samples.emlx('Subject: x\r\n\r\nbody\r\n');
  assert.equal(M.unwrapEmlx(b).toString(), 'Subject: x\r\n\r\nbody\r\n');
  assert.equal(M.unwrapEmlx(Buffer.from('Subject: plain\n\nx')).toString(), 'Subject: plain\n\nx');
});

test('queryIndex: words match sender, recipient and subject; sorts are stable', () => {
  const e = [
    { from: 'Ana', to: 'Bo', subject: 'Lunch plan', date: 3, size: 10 },
    { from: 'Cy', to: 'Ana', subject: 'Build red', date: null, size: 30 },
    { from: 'bob', to: 'Di', subject: 'lunch? yes', date: 1, size: 20 },
  ];
  assert.deepEqual(M.queryIndex(e, { query: 'lunch' }), [0, 2]);
  assert.deepEqual(M.queryIndex(e, { query: 'ana build' }), [1]);
  assert.deepEqual(M.queryIndex(e, { sort: 'date', desc: true }), [0, 2, 1]);
  assert.deepEqual(M.queryIndex(e, { sort: 'from' }), [0, 2, 1]);
  assert.deepEqual(M.queryIndex(e, { sort: 'size', desc: true }), [1, 2, 0]);
  assert.deepEqual(M.queryIndex(e, { sort: 'nonsense' }), [0, 1, 2]);
});

test('a 30 MB mailbox is indexed from disk in chunks, fast', async () => {
  const f = path.join(tmp, 'big.mbox');
  const one = samples.mbox(2000, Date.UTC(2024, 0, 1));
  const fd = fs.openSync(f, 'w');
  for (let i = 0; i < 13; i++) fs.writeSync(fd, (i ? '\n' : '') + one);
  fs.closeSync(fd);
  const size = fs.statSync(f).size;
  assert.ok(size > 25e6 && size < 50e6);
  const s = await FileSource.open(f);
  const t0 = Date.now();
  const r = await M.indexMbox(s);
  const ms = Date.now() - t0;
  await s.close();
  assert.equal(r.entries.length, 26000);
  assert.ok(ms < 5000, `indexing took ${ms} ms`);
  fs.rmSync(f);
});

test('the generated mailbox has 2,500 messages and quoted From lines', async () => {
  const dir = path.join(tmp, 'samples');
  samples.writeAll(dir, 2500);
  const s = await FileSource.open(path.join(dir, 'team-inbox.mbox'));
  const r = await M.indexMbox(s);
  assert.equal(r.entries.length, 2500);
  const e = r.entries[7];
  const body = M.unwrapMessage(await s.read(e.start, e.end - e.start)).toString();
  await s.close();
  assert.match(body, /\n>From the notes/);
  assert.ok(!/^From /m.test(body.split('\n\n').slice(1).join('\n\n')) || /\nFrom now on/.test(body));
  for (const f of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, f)).size < 5e6, f);
});
