'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { FileSource, BufferSource } = require('./core/source');
const { indexMbox, unwrapMessage, unwrapEmlx, queryIndex } = require('./core/mbox');
const { parseMessage } = require('./core/message');
const { validateWebviewMessage, sizePlan, fmtSize, kindOf, pageRows, MB } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');

const VIEW_TYPE = 'emlViewer.preview';
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('emlViewer');
  return { maxMessageMB: c.get('maxMessageMB', 200), remoteImages: c.get('alwaysShowRemoteImages', false) };
}

function errText(e) { return e && e.message ? e.message : String(e); }

class EmlEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    const name = path.posix.basename(uri.path);
    let kind = kindOf(name);
    const st = { remote: settings().remoteImages, ui: null, current: null, entries: null, indexDone: false, indexing: null, atts: [], cache: null, disposed: false, counted: false, abort: { aborted: false }, size: 0 };
    const setHtml = () => {
      panel.webview.html = buildHtml({
        cspSource: panel.webview.cspSource,
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
        styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
        title: name,
        remoteImages: st.remote,
      });
    };
    const post = m => (st.disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const sendMessage = async (bytes, index) => {
      const { model, attachments } = await parseMessage(bytes);
      st.atts = attachments;
      st.current = index;
      await post({ type: 'message', index, model });
    };

    const openSource = async () => {
      if (uri.scheme === 'file') return FileSource.open(uri.fsPath);
      return new BufferSource(await vscode.workspace.fs.readFile(uri));
    };

    const startIndex = async () => {
      const src = await openSource();
      let last = 0;
      st.entries = [];
      try {
        const res = await indexMbox(src, {
          signal: st.abort,
          onBatch: async (added, scanned) => {
            for (const e of added) st.entries.push(e);
            st.cache = null;
            const now = Date.now();
            if (now - last > 200 || (added.length && st.entries.length === added.length)) {
              last = now;
              await post({ type: 'index', total: st.entries.length, scanned, size: st.size, done: false });
            }
          },
        });
        if (res.aborted) return;
        st.entries = res.entries;
        st.indexDone = true;
        st.cache = null;
        await post({ type: 'index', total: st.entries.length, scanned: st.size, size: st.size, done: true, ms: res.ms });
      } finally { await src.close(); }
    };

    const readEntry = async (e) => {
      const len = e.end - e.start;
      if (len > settings().maxMessageMB * MB) throw new Error(`Message ${e.i + 1} is ${fmtSize(len)}. EML Viewer parses messages up to ${settings().maxMessageMB} MB (setting emlViewer.maxMessageMB).`);
      const src = await openSource();
      try { return unwrapMessage(await src.read(e.start, len), e.single); } finally { await src.close(); }
    };

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          const stat = await vscode.workspace.fs.stat(uri);
          st.size = stat.size;
          // a mailbox without a known extension (Thunderbird "Inbox", "Sent") starts with a "From " line
          if (kind === 'eml' && !/\.eml$/i.test(name) && stat.size > 5 && uri.scheme === 'file') {
            const src = await FileSource.open(uri.fsPath);
            try { if ((await src.read(0, 5)).toString('latin1') === 'From ') kind = 'mbox'; } finally { await src.close(); }
          }
          const plan = sizePlan(stat.size, kind === 'mbox' ? 'mbox' : 'eml', settings().maxMessageMB);
          await post({ type: 'init', name, kind: kind === 'mbox' ? 'mbox' : 'eml', size: stat.size, sizeText: fmtSize(stat.size), remote: st.remote, ui: st.ui, current: st.current, plan });
          if (!plan.open) return;
          if (kind === 'mbox') {
            if (st.entries && st.indexDone) {
              await post({ type: 'index', total: st.entries.length, scanned: st.size, size: st.size, done: true, ms: 0 });
              if (st.current !== null && st.entries[st.current]) await sendMessage(await readEntry(st.entries[st.current]), st.current);
            } else if (!st.indexing) {
              st.indexing = startIndex().catch(e => post({ type: 'error', message: errText(e) }));
            }
            return;
          }
          let bytes = await vscode.workspace.fs.readFile(uri);
          if (kind === 'emlx') bytes = unwrapEmlx(bytes);
          await sendMessage(bytes, 0);
          return;
        }
        if (msg.type === 'page') {
          const entries = st.entries || [];
          const key = `${entries.length}|${msg.query}|${msg.sort}|${msg.desc}`;
          if (!st.cache || st.cache.key !== key) st.cache = { key, ids: queryIndex(entries, msg) };
          const ids = st.cache.ids;
          await post({ type: 'page', req: msg.req, offset: msg.offset, total: ids.length, all: entries.length, done: st.indexDone, rows: pageRows(entries, ids, msg.offset, msg.limit) });
          return;
        }
        if (msg.type === 'open') {
          const e = st.entries && st.entries[msg.index];
          if (!e) return;
          await sendMessage(await readEntry(e), msg.index);
          return;
        }
        if (msg.type === 'rendered') { if (!st.counted) { st.counted = true; rating.success(); } return; }
        if (msg.type === 'showImages' || msg.type === 'blockImages') {
          st.remote = msg.type === 'showImages';
          st.ui = msg.ui || null;
          setHtml();
          return;
        }
        if (msg.type === 'openText') { await vscode.commands.executeCommand('vscode.openWith', uri, 'default'); return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied' }); return; }
        if (msg.type === 'openLink') {
          const pick = await vscode.window.showWarningMessage(`Open this link from the message?\n\n${msg.url.slice(0, 500)}`, { modal: true }, 'Open Link');
          if (pick === 'Open Link') await vscode.env.openExternal(vscode.Uri.parse(msg.url, true));
          return;
        }
        if (msg.type === 'save') {
          const a = st.atts[msg.att];
          if (!a) return;
          const folder = uri.with({ path: path.posix.dirname(uri.path) });
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, a.filename), saveLabel: 'Save Attachment' });
          if (!target) { await post({ type: 'saved', cancelled: true }); return; }
          if (target.toString() === uri.toString()) {
            await post({ type: 'error', soft: true, message: 'Choose another file name. The mail file itself is never overwritten.' });
            return;
          }
          await vscode.workspace.fs.writeFile(target, new Uint8Array(a.content));
          await post({ type: 'saved', path: target.scheme === 'file' ? target.fsPath : target.toString(), bytes: a.size });
        }
      } catch (e) {
        await post({ type: 'error', message: errText(e) });
      }
    });
    panel.onDidDispose(() => { st.disposed = true; st.abort.aborted = true; st.entries = null; st.atts = []; });
    setHtml();
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.eml-viewer', section: 'emlViewer', message: (n) => `EML Viewer has opened ${n} mail files for you. A rating helps other people find it.` });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new EmlEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('emlViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.eml-viewer#emlViewer.start', false)),
    vscode.commands.registerCommand('emlViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, EmlEditorProvider, VIEW_TYPE };
