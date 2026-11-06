'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol');
const { buildHtml } = require('../src/html');
const S = require('../src/webview/sanitize');
const U = require('../src/webview/view-util');

test('only known webview messages pass, with checked fields', () => {
  const ok = m => P.validateWebviewMessage(m);
  assert.equal(ok({ type: 'ready' }).ok, true);
  assert.equal(ok({ type: 'writeFile', path: '/etc/x' }).ok, false);
  assert.equal(ok({ type: 'openExternal', url: 'https://example.com' }).ok, false);
  assert.equal(ok(null).ok, false);
  assert.deepEqual(ok({ type: 'open', index: 3 }).msg, { type: 'open', index: 3 });
  assert.equal(ok({ type: 'open', index: -1 }).ok, false);
  assert.equal(ok({ type: 'open', index: '3' }).ok, false);
  assert.equal(ok({ type: 'save', att: 1.5 }).ok, false);
  assert.equal(ok({ type: 'openLink', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(ok({ type: 'openLink', url: 'file:///etc/passwd' }).ok, false);
  assert.equal(ok({ type: 'openLink', url: 'https://www.example.com/a' }).ok, true);
  assert.equal(ok({ type: 'openLink', url: 'mailto:a@example.com' }).ok, true);
  const pg = ok({ type: 'page', offset: 0, limit: 200, query: 'x', sort: 'evil', desc: 1, req: 4 });
  assert.deepEqual(pg.msg, { type: 'page', offset: 0, limit: 200, query: 'x', sort: 'file', desc: true, req: 4 });
  assert.equal(ok({ type: 'page', offset: 0, limit: 5000, req: 1 }).ok, false);
  assert.deepEqual(ok({ type: 'showImages', ui: { query: 'a', sort: 'date', desc: true, offset: 200, tab: 'auth', extra: 1 } }).msg,
    { type: 'showImages', ui: { query: 'a', sort: 'date', desc: true, offset: 200, tab: 'auth' } });
  assert.deepEqual(ok({ type: 'blockImages', ui: { tab: '<x>' } }).msg.ui.tab, 'html');
});

test('size rules: 4 GB hard limit for every file, message limit for .eml', () => {
  const GB = P.GB, MB = P.MB;
  assert.equal(P.sizePlan(4 * GB, 'mbox', 200).open, true);
  const over = P.sizePlan(4 * GB + 1, 'mbox', 200);
  assert.equal(over.open, false);
  assert.match(over.message, /4\.0 GB.*up to 4 GB/);
  assert.equal(P.sizePlan(150 * MB, 'eml', 200).open, true);
  assert.match(P.sizePlan(250 * MB, 'eml', 200).message, /250 MB.*200 MB.*emlViewer\.maxMessageMB/);
  assert.equal(P.sizePlan(250 * MB, 'mbox', 200).open, true);
  assert.equal(P.kindOf('a.MBOX'), 'mbox');
  assert.equal(P.kindOf('a.mbx'), 'mbox');
  assert.equal(P.kindOf('a.emlx'), 'emlx');
  assert.equal(P.kindOf('a.eml'), 'eml');
  assert.equal(P.fmtSize(1536), '1.5 KB');
});

test('CSP: nonce scripts only, no remote images until asked, escaped title', () => {
  const html = buildHtml({ cspSource: 'https://res', scriptUri: 'https://res/w.js', styleUri: 'https://res/w.css', title: '<x>"', nonce: 'N' });
  const csp = html.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(csp, /img-src https:\/\/res data:;/);
  assert.doesNotMatch(csp, /connect-src|https: http:/);
  assert.match(csp, /form-action 'none'/);
  assert.match(html, /<title>&lt;x&gt;&quot;<\/title>/);
  assert.match(html, /data-remote="0"/);
  const on = buildHtml({ cspSource: 'https://res', scriptUri: 'a', styleUri: 'b', title: 't', nonce: 'N', remoteImages: true });
  assert.match(on, /img-src https:\/\/res data: https: http:;/);
  assert.match(on, /data-remote="1"/);
});

test('webview code: no innerHTML, eval or network; iframe without allow-scripts', () => {
  const dir = path.join(__dirname, '..', 'src', 'webview');
  const code = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/);
  assert.match(code, /sandbox: 'allow-same-origin'/);
  assert.doesNotMatch(code, /['"][^'"\n]*allow-(scripts|popups|forms|top-navigation)[^'"\n]*['"]/);
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.equal((host.match(/workspace\.fs\.writeFile/g) || []).length, 1, 'the only write is Save attachment');
  assert.doesNotMatch(host, /https?\.request|fetch\(|net\.connect/);
});

test('sanitizer helpers: remote detection, cid lookup, CSS urls and @import', () => {
  assert.equal(S.isRemote('https://a.example.com/x.png'), true);
  assert.equal(S.isRemote('//a.example.com/x.png'), true);
  assert.equal(S.isRemote('cid:x'), false);
  assert.equal(S.isRemote('data:image/png;base64,AA'), false);
  assert.equal(S.cidOf('cid:<Logo@Example.com>'), 'logo@example.com');
  assert.equal(S.cidOf('cid:a%40b'), 'a@b');
  assert.equal(S.cidOf('https://x'), '');
  const st = { remote: 0, cid: 0, cidMissing: 0, removed: 0 };
  const css = S.rewriteCss('@import url(https://x.example/a.css); .a{background:url("https://x.example/b.png")} .b{background:url(cid:logo@example.com)} .c{background:url(cid:missing)} .d{background:url(javascript:alert(1))} .e{background:url(data:image/png;base64,AA)}', { 'logo@example.com': 'data:image/png;base64,QQ' }, false, st);
  assert.doesNotMatch(css, /@import|https:|javascript:/);
  assert.match(css, /url\("data:image\/png;base64,QQ"\)/);
  assert.match(css, /url\(data:image\/png;base64,AA\)/);
  assert.deepEqual(st, { remote: 1, cid: 1, cidMissing: 1, removed: 2 });
  const st2 = { remote: 0, cid: 0, cidMissing: 0, removed: 0 };
  assert.match(S.rewriteCss('.a{background:url(https://x.example/b.png)}', {}, true, st2), /https:\/\/x\.example\/b\.png/);
  assert.equal(st2.remote, 1);
  assert.deepEqual(S.srcsetUrls('a.png 1x, https://x/b.png 2x'), ['a.png', 'https://x/b.png']);
  assert.ok(S.DROP_TAGS.includes('meta') && S.DROP_TAGS.includes('base') && S.DROP_TAGS.includes('script'));
});

test('view helpers: addresses, delays, auth badges, sort options', () => {
  assert.equal(U.addrs([{ name: 'A B', address: 'a@example.com' }, { name: '', address: 'c@example.com' }]), 'A B <a@example.com>, c@example.com');
  assert.equal(U.fmtDelay(42), '+42 s');
  assert.equal(U.fmtDelay(185), '+3 min 5 s');
  assert.equal(U.fmtDelay(-30), '-30 s (clock skew)');
  assert.equal(U.fmtDelay(null), '');
  assert.equal(U.resultClass('pass'), 'pass');
  assert.equal(U.resultClass('softfail'), 'fail');
  assert.equal(U.resultClass('none'), 'neutral');
  assert.equal(U.resultClass(undefined), 'none');
  assert.equal(U.authDetail({ method: 'dmarc', result: 'pass', props: { 'header.from': 'example.com' }, comment: 'p=REJECT sp=NONE' }), 'example.com p=REJECT');
  assert.equal(U.authDetail(null), 'not recorded');
  assert.equal(U.shortDate(null), '');
  assert.equal(U.SORT_OPTIONS.length, 6);
});
