'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/core/headers');

test('splitHeaders joins folded lines and keeps order and duplicates', () => {
  const h = H.splitHeaders('Received: from a\r\n\tby b; Mon, 1 Jan 2024 00:00:00 +0000\r\nSubject: one\r\n two\r\nReceived: from c by d\r\nbad line\r\n');
  assert.deepEqual(h.map(x => x.key), ['received', 'subject', 'received']);
  assert.equal(h[1].value, 'one two');
  assert.match(h[0].value, /^from a by b;/);
});

test('summarize decodes encoded words and names, and reads the date', () => {
  const s = H.summarize('From: =?UTF-8?B?w4lsb2RpZSBCcsOpbW9uZA==?= <e@example.org>\nTo: a@example.com, "Bo B" <b@example.com>\nSubject: =?utf-8?q?R=C3=A9sum=C3=A9?= ok\nDate: Tue, 3 Nov 2026 10:00:00 +0100\nContent-Type: multipart/mixed; boundary=x');
  assert.equal(s.from, 'Élodie Brémond');
  assert.equal(s.to, 'a@example.com, Bo B');
  assert.equal(s.subject, 'Résumé ok');
  assert.equal(s.date, Date.UTC(2026, 10, 3, 9, 0, 0));
  assert.equal(s.attach, true);
  assert.equal(H.summarize('Subject: x').date, null);
});

test('Authentication-Results: methods, props, comments, several DKIM results, none', () => {
  const r = H.parseAuthResultsValue('mx.example.org; spf=pass (sender ok) smtp.mailfrom=example.com; dkim=fail header.d=other.example; dkim=pass header.d=example.com header.s=s1; dmarc=pass (p=REJECT) header.from=example.com');
  assert.equal(r.serv, 'mx.example.org');
  assert.deepEqual(r.results.map(x => `${x.method}=${x.result}`), ['spf=pass', 'dkim=fail', 'dkim=pass', 'dmarc=pass']);
  assert.equal(r.results[0].comment, 'sender ok');
  assert.equal(r.results[2].props['header.s'], 's1');
  const info = H.authInfo([{ key: 'authentication-results', value: 'mx.example.org; spf=pass (sender ok) smtp.mailfrom=example.com; dkim=fail header.d=other.example; dkim=pass header.d=example.com' }]);
  assert.equal(info.summary.dkim.result, 'pass', 'best DKIM result wins the badge');
  assert.equal(info.summary.dmarc, null);
  assert.deepEqual(H.parseAuthResultsValue('mx.example.org; none').results, []);
  const arc = H.parseAuthResultsValue('i=1; mx.example.org; spf=pass smtp.mailfrom=example.com');
  assert.equal(arc.serv, 'mx.example.org');
  assert.equal(arc.results[0].result, 'pass');
});

test('authInfo falls back to Received-SPF and lists DKIM signatures and ARC seals', () => {
  const info = H.authInfo([
    { key: 'received-spf', value: 'softfail (domain does not designate) client-ip=192.0.2.1;' },
    { key: 'dkim-signature', value: 'v=1; a=rsa-sha256; d=example.com; s=sel;\r\n h=from:to:subject; bh=x; b=y' },
    { key: 'arc-seal', value: 'i=1; a=rsa-sha256; cv=none; d=example.org; s=arc; b=z' },
  ]);
  assert.equal(info.summary.spf.result, 'softfail');
  assert.deepEqual(info.dkimSignatures, [{ d: 'example.com', s: 'sel', a: 'rsa-sha256', h: 3 }]);
  assert.deepEqual(info.arcSeals, [{ i: 1, cv: 'none', d: 'example.org' }]);
  assert.equal(info.verified, false);
});

test('Received: from, ip, by, with, id, TLS and date', () => {
  const r = H.parseReceived('from mail.example.com (mail.example.com [198.51.100.7])\r\n\tby mx1.example.org with ESMTPS id ABC123\r\n\tfor <x@example.org>; Tue, 3 Nov 2026 10:00:05 +0000');
  assert.equal(r.from, 'mail.example.com');
  assert.equal(r.ip, '198.51.100.7');
  assert.equal(r.by, 'mx1.example.org');
  assert.equal(r.with, 'ESMTPS');
  assert.equal(r.id, 'ABC123');
  assert.equal(r.tls, true);
  assert.equal(r.date, Date.UTC(2026, 10, 3, 10, 0, 5));
  const v6 = H.parseReceived('from [IPv6:2001:db8::1] by mx.example.org; Tue, 3 Nov 2026 10:00:05 +0000');
  assert.equal(v6.ip, '2001:db8::1');
  assert.equal(H.parseReceived('garbage').date, null);
});

test('receivedHops: oldest first with delays; missing dates do not break the chain', () => {
  const hops = H.receivedHops([
    { key: 'received', value: 'from b by c; Tue, 3 Nov 2026 10:01:00 +0000' },
    { key: 'received', value: 'from x by y' },
    { key: 'received', value: 'from a by b; Tue, 3 Nov 2026 10:00:00 +0000' },
  ]);
  assert.deepEqual(hops.map(h => h.from), ['a', 'x', 'b']);
  assert.deepEqual(hops.map(h => h.delay), [null, null, 60]);
});
