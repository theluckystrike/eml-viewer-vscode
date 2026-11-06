'use strict';
// The extension host on a mocked VS Code API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const samples = require('../scripts/make-samples');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emlv-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
samples.writeAll(tmp, 600);

const state = { config: { maxMessageMB: 200, alwaysShowRemoteImages: false, askForRating: true }, saveTarget: null, clipboard: '', warn: undefined, opened: [], cmds: [] };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: { stat: async u => ({ size: fs.statSync(u.fsPath).size }), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d) },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showSaveDialog: async () => state.saveTarget,
    showWarningMessage: async (...a) => { state.warnArgs = a; return state.warn; },
    showInformationMessage: async () => undefined,
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async (...a) => { state.cmds.push(a); } },
  env: { clipboard: { writeText: async t => { state.clipboard = t; } }, sessionId: 's1', openExternal: async u => { state.opened.push(String(u)); return true; } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

const globalState = { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } };
const ctx = { extensionUri: uriOf('/ext'), subscriptions: [], globalState };
ext.activate(ctx);
const provider = vscodeMock.window.registered[0][1];

function fakePanel() {
  const sent = []; let handler = null; let dispose = null; const htmls = [];
  const panel = {
    webview: { options: null, get html() { return htmls[htmls.length - 1]; }, set html(v) { htmls.push(v); }, cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: h => { dispose = h; },
  };
  return { panel, sent, htmls, send: m => handler(m), close: () => dispose() };
}
async function open(file) {
  const f = fakePanel();
  await provider.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return f;
}
async function waitFor(f, pred, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const m = f.sent.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout; got ' + f.sent.map(m => m.type).join(','));
}

test('activate registers the custom editor and the commands; manifest matches', () => {
  assert.equal(vscodeMock.window.registered[0][0], 'emlViewer.preview');
  assert.deepEqual(vscodeMock.commands.list.sort(), ['emlViewer.moreViewers', 'emlViewer.openWalkthrough', 'emlViewer.openWith', 'emlViewer.supportDeveloper']);
  const pkg = require('../package.json');
  assert.equal(pkg.contributes.customEditors[0].viewType, ext.VIEW_TYPE);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern), ['*.eml', '*.emlx', '*.mbox', '*.mbx']);
  assert.ok(pkg.displayName.toLowerCase().startsWith('eml viewer') && pkg.displayName.length <= 45);
  assert.equal(pkg.keywords.length, 30);
  assert.equal(new Set(pkg.keywords).size, 30);
  assert.equal(pkg.version, '0.1.1');
});

test('.eml: init then the parsed message; html set with images blocked', async () => {
  const f = await open(path.join(tmp, 'newsletter.eml'));
  assert.match(f.htmls[0], /img-src https:\/\/csp data:;/);
  await f.send({ type: 'ready' });
  const init = await waitFor(f, m => m.type === 'init');
  assert.equal(init.kind, 'eml');
  assert.equal(init.plan.open, true);
  const msg = await waitFor(f, m => m.type === 'message');
  assert.equal(msg.model.subject, 'October product update: faster dashboards and team spaces');
  assert.equal(msg.model.attachments.length, 4);
});

test('.emlx opens through its byte count', async () => {
  const f = await open(path.join(tmp, 'apple-mail.emlx'));
  await f.send({ type: 'ready' });
  const msg = await waitFor(f, m => m.type === 'message');
  assert.match(msg.model.subject, /^Apple Mail copy of the meeting notes$/);
});

test('.mbox: index, page, search, sort and open a message', async () => {
  const f = await open(path.join(tmp, 'team-inbox.mbox'));
  await f.send({ type: 'ready' });
  assert.equal((await waitFor(f, m => m.type === 'init')).kind, 'mbox');
  const done = await waitFor(f, m => m.type === 'index' && m.done);
  assert.equal(done.total, 600);
  await f.send({ type: 'page', offset: 0, limit: 200, query: '', sort: 'date', desc: true, req: 1 });
  const pg = await waitFor(f, m => m.type === 'page' && m.req === 1);
  assert.equal(pg.total, 600);
  assert.equal(pg.rows.length, 200);
  assert.ok(pg.rows[0].date >= pg.rows[1].date);
  await f.send({ type: 'page', offset: 0, limit: 50, query: 'lunch', sort: 'file', desc: false, req: 2 });
  const q = await waitFor(f, m => m.type === 'page' && m.req === 2);
  assert.ok(q.total > 0 && q.total < 600);
  assert.ok(q.rows.every(r => /lunch/i.test(r.subject + r.from + r.to)));
  await f.send({ type: 'open', index: 7 });
  const msg = await waitFor(f, m => m.type === 'message' && m.index === 7);
  assert.match(msg.model.text, /\n>From the notes/);
  await f.send({ type: 'open', index: 99999 });
});

test('a mailbox without an extension (Thunderbird "Inbox") is detected by its From_ line', async () => {
  const p = path.join(tmp, 'Inbox');
  fs.copyFileSync(path.join(tmp, 'team-inbox.mbox'), p);
  const f = await open(p);
  await f.send({ type: 'ready' });
  assert.equal((await waitFor(f, m => m.type === 'init')).kind, 'mbox');
  f.close();
});

test('Save writes the attachment bytes, refuses the mail file itself, handles cancel', async () => {
  const src = path.join(tmp, 'newsletter.eml');
  const f = await open(src);
  await f.send({ type: 'ready' });
  await waitFor(f, m => m.type === 'message');
  state.saveTarget = uriOf(path.join(tmp, 'out.csv'));
  await f.send({ type: 'save', att: 2 });
  const saved = await waitFor(f, m => m.type === 'saved' && !m.cancelled);
  assert.equal(saved.bytes, 105);
  assert.match(fs.readFileSync(path.join(tmp, 'out.csv'), 'utf8'), /^month,signups,churn/);
  const before = fs.readFileSync(src);
  state.saveTarget = uriOf(src);
  await f.send({ type: 'save', att: 2 });
  assert.match((await waitFor(f, m => m.type === 'error' && m.soft)).message, /never overwritten/);
  assert.deepEqual(fs.readFileSync(src), before);
  state.saveTarget = undefined;
  await f.send({ type: 'save', att: 3 });
  await waitFor(f, m => m.type === 'saved' && m.cancelled);
  await f.send({ type: 'save', att: 40 });
});

test('files over 4 GB get the message and nothing is read', async () => {
  const p = path.join(tmp, 'huge.mbox');
  const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, 4 * 1024 ** 3 + 10); fs.closeSync(fd);
  const f = await open(p);
  await f.send({ type: 'ready' });
  const init = await waitFor(f, m => m.type === 'init');
  assert.equal(init.plan.open, false);
  assert.match(init.plan.message, /4\.0 GB.*up to 4 GB/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.sent.filter(m => m.type === 'index').length, 0);
  fs.rmSync(p);
});

test('an .eml over the message limit gets a clear message', async () => {
  state.config.maxMessageMB = 0.001;
  const f = await open(path.join(tmp, 'newsletter.eml'));
  await f.send({ type: 'ready' });
  const init = await waitFor(f, m => m.type === 'init');
  state.config.maxMessageMB = 200;
  assert.equal(init.plan.open, false);
  assert.match(init.plan.message, /emlViewer\.maxMessageMB/);
});

test('Show images reloads the webview with remote images allowed and keeps the UI state', async () => {
  const f = await open(path.join(tmp, 'team-inbox.mbox'));
  await f.send({ type: 'ready' });
  await waitFor(f, m => m.type === 'index' && m.done);
  await f.send({ type: 'open', index: 3 });
  await waitFor(f, m => m.type === 'message');
  await f.send({ type: 'showImages', ui: { query: 'q', sort: 'date', desc: true, offset: 0, tab: 'route' } });
  assert.equal(f.htmls.length, 2);
  assert.match(f.htmls[1], /img-src https:\/\/csp data: https: http:;/);
  f.sent.length = 0;
  await f.send({ type: 'ready' });
  const init = await waitFor(f, m => m.type === 'init');
  assert.equal(init.remote, true);
  assert.equal(init.current, 3);
  assert.equal(init.ui.tab, 'route');
  assert.equal((await waitFor(f, m => m.type === 'message')).index, 3);
  await f.send({ type: 'blockImages', ui: null });
  assert.match(f.htmls[2], /img-src https:\/\/csp data:;/);
});

test('links open only after the modal is confirmed; other messages are dropped', async () => {
  const f = await open(path.join(tmp, 'newsletter.eml'));
  state.warn = undefined;
  await f.send({ type: 'openLink', url: 'https://www.example.com/changelog' });
  assert.equal(state.opened.length, 0);
  assert.equal(state.warnArgs[1].modal, true);
  state.warn = 'Open Link';
  await f.send({ type: 'openLink', url: 'https://www.example.com/changelog' });
  assert.deepEqual(state.opened, ['https://www.example.com/changelog']);
  await f.send({ type: 'openLink', url: 'javascript:alert(1)' });
  await f.send({ type: 'writeFile', path: '/tmp/x' });
  assert.equal(state.opened.length, 1);
  await f.send({ type: 'copy', text: 'hello' });
  assert.equal(state.clipboard, 'hello');
  await f.send({ type: 'openText' });
  assert.equal(state.cmds.at(-1)[0], 'vscode.openWith');
  assert.equal(state.cmds.at(-1)[2], 'default');
});

test('rendered counts one success per tab; nothing is posted after close', async () => {
  const f = await open(path.join(tmp, 'invoice-spf-fail.eml'));
  const before = (globalState.get('zovo.rating.v1') || {}).count || 0;
  await f.send({ type: 'rendered' });
  await f.send({ type: 'rendered' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(globalState.get('zovo.rating.v1').count, before + 1);
  f.close();
  const n = f.sent.length;
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, n);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('emlViewer.supportDeveloper') && ids.includes('emlViewer.moreViewers'));
  const prop = [].concat(pkg.contributes.configuration).map(c => c.properties['emlViewer.showSupportLinks']).find(Boolean);
  assert.equal(prop.default, true);
  assert.ok(support.otherProducts('zovo.eml-viewer').every(p => p.id !== 'zovo.eml-viewer'));
});

test('support: the footer shows by default, emlViewer.showSupportLinks=false hides it, the CSP is unchanged', async () => {
  try {
    for (const [val, shown] of [[undefined, true], [false, false]]) {
      if (val === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = val;
      const f = await open(path.join(tmp, 'newsletter.eml'));
      const html = f.panel.webview.html;
      assert.equal(/id="zovo-support"/.test(html), shown, String(val));
      assert.equal(html.includes('command:emlViewer.supportDeveloper'), shown);
      // the style-src keeps 'unsafe-inline' for message HTML: no nonce on styles
      assert.match(html, /style-src https:\/\/csp 'unsafe-inline'; script-src 'nonce-/);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['emlViewer.supportDeveloper', 'emlViewer.moreViewers', 'workbench.action.openSettings']);
      f.close();
    }
  } finally { delete state.config.showSupportLinks; }
});
