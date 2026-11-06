'use strict';
// Webview UI. Every piece of message text goes in with textContent; message HTML goes only into the sandboxed iframe.
const { sanitizeEmailHtml } = require('./sanitize');
const U = require('./view-util');

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const remoteOn = app.dataset.remote === '1';
const parse = s => new DOMParser().parseFromString(s, 'text/html');
const PAGE = 200;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const S = { kind: 'eml', name: '', ui: { query: '', sort: 'file', desc: false, offset: 0, tab: 'html' }, msg: null, index: null, total: 0, all: 0, done: false, rows: [], req: 0, rendered: false, sel: -1 };

// ---------- layout ----------
const titleEl = h('span', { class: 'title' });
const infoEl = h('span', { class: 'muted small info' });
const bar = h('div', { class: 'bar' }, titleEl, infoEl, h('span', { class: 'spacer' }),
  h('button', { onclick: () => vscode.postMessage({ type: 'openText' }), title: 'Open the raw file in the text editor' }, 'Open as text'));
const listPane = h('div', { class: 'listpane', hidden: true });
const msgPane = h('div', { class: 'msgpane' });
const main = h('div', { class: 'main' }, listPane, msgPane);
const status = h('div', { class: 'status' }, h('span', { class: 'stat-left' }), h('span', { class: 'stat-right muted' }));
const setStatus = (l, r) => { if (l !== undefined) status.firstChild.textContent = l; if (r !== undefined) status.lastChild.textContent = r; };

// ---------- MBOX list ----------
const search = h('input', { type: 'search', placeholder: 'Search sender, recipient, subject', 'aria-label': 'Search messages' });
const sortSel = h('select', { 'aria-label': 'Sort messages' }, U.SORT_OPTIONS.map(([k, d, label], i) => h('option', { value: String(i) }, label)));
const listEl = h('div', { class: 'list', role: 'listbox', tabindex: '0', 'aria-label': 'Messages' });
const pagerLabel = h('span', { class: 'muted small pagerlabel' });
const prevBtn = h('button', { onclick: () => movePage(-1), title: 'Previous page' }, 'Prev');
const nextBtn = h('button', { onclick: () => movePage(1), title: 'Next page' }, 'Next');
listPane.append(h('div', { class: 'listtools' }, search, sortSel), listEl, h('div', { class: 'pager' }, prevBtn, pagerLabel, nextBtn));
let searchTimer = 0;
search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.ui.query = search.value; S.ui.offset = 0; requestPage(); }, 200); });
sortSel.addEventListener('change', () => { const [k, d] = U.SORT_OPTIONS[Number(sortSel.value)]; S.ui.sort = k; S.ui.desc = d; S.ui.offset = 0; requestPage(); });
listEl.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k') return;
  e.preventDefault();
  const pos = S.rows.findIndex(r => r.i === S.index);
  const next = pos + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1);
  if (next >= 0 && next < S.rows.length) openRow(S.rows[next].i);
  else if (next >= S.rows.length && S.ui.offset + PAGE < S.total) movePage(1, true);
  else if (next < 0 && S.ui.offset > 0) movePage(-1, true);
});

function movePage(dir, openEdge) {
  const off = S.ui.offset + dir * PAGE;
  if (off < 0 || off >= Math.max(S.total, 1)) return;
  S.ui.offset = off; S.openEdge = openEdge ? dir : 0;
  requestPage();
}
function requestPage() {
  S.req++;
  vscode.postMessage({ type: 'page', offset: S.ui.offset, limit: PAGE, query: S.ui.query, sort: S.ui.sort, desc: S.ui.desc, req: S.req });
}
function openRow(i) {
  S.index = i;
  for (const el of listEl.children) el.setAttribute('aria-selected', String(Number(el.dataset.i) === i));
  const cur = listEl.querySelector('[aria-selected="true"]');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  vscode.postMessage({ type: 'open', index: i });
  setStatus(`Opening message ${i + 1}...`);
}
function renderList() {
  listEl.textContent = '';
  if (!S.rows.length) listEl.append(h('div', { class: 'empty muted' }, S.ui.query ? 'No message matches the search.' : (S.done ? 'This mailbox has no messages.' : 'Indexing...')));
  for (const r of S.rows) {
    listEl.append(h('div', { class: 'row', role: 'option', 'data-i': String(r.i), 'aria-selected': String(r.i === S.index), onclick: () => openRow(r.i) },
      h('div', { class: 'r1' }, h('span', { class: 'from' }, r.from || '(no sender)'), h('span', { class: 'date muted' }, U.shortDate(r.date))),
      h('div', { class: 'r2' }, h('span', { class: 'subj' }, r.subject || '(no subject)'), r.attach ? h('span', { class: 'clip', title: 'Has attachments' }, '📎') : null, h('span', { class: 'size muted' }, U.fmtSize(r.size)))));
  }
  const from = S.total ? S.ui.offset + 1 : 0, to = Math.min(S.total, S.ui.offset + PAGE);
  pagerLabel.textContent = `${from.toLocaleString()}-${to.toLocaleString()} of ${S.total.toLocaleString()}${S.ui.query ? ` (of ${S.all.toLocaleString()})` : ''}`;
  prevBtn.disabled = S.ui.offset === 0; nextBtn.disabled = S.ui.offset + PAGE >= S.total;
}

// ---------- message view ----------
const TABS = [['html', 'Message'], ['text', 'Text'], ['auth', 'Authentication'], ['route', 'Route'], ['headers', 'Headers'], ['source', 'Source']];
let frame = null;

function badge(label, r) {
  const cls = U.resultClass(r && r.result);
  return h('span', { class: `badge ${cls}`, title: r ? `${label}: ${r.result}${r.comment ? ` (${r.comment})` : ''}` : `${label}: not recorded` },
    h('b', null, label), ' ', r ? r.result : 'none');
}

function renderMessage() {
  const m = S.msg;
  msgPane.textContent = '';
  if (!m) return;
  const sum = m.auth.summary;
  const rows = [['From', U.addrs(m.from)], ['To', U.addrs(m.to)], ['Cc', U.addrs(m.cc)], ['Bcc', U.addrs(m.bcc)], ['Reply-To', U.addrs(m.replyTo) !== U.addrs(m.from) ? U.addrs(m.replyTo) : ''],
    ['Date', m.dateMs !== null ? `${new Date(m.dateMs).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })}` : m.date]].filter(r => r[1]);
  const card = h('div', { class: 'card' },
    h('div', { class: 'subject' }, m.subject || '(no subject)'),
    h('table', { class: 'kv' }, rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))),
    h('div', { class: 'badges' }, badge('SPF', sum.spf), badge('DKIM', sum.dkim), badge('DMARC', sum.dmarc),
      h('button', { class: 'link', onclick: () => setTab('auth') }, 'Details'),
      m.hops.length ? h('button', { class: 'link', onclick: () => setTab('route') }, `${m.hops.length} hops`) : null));
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) =>
    h('button', { role: 'tab', 'data-tab': id, 'aria-selected': String(S.ui.tab === id), onclick: () => setTab(id) }, label)));
  const atts = m.attachments.filter(a => !a.inline);
  const attBar = atts.length ? h('div', { class: 'atts' }, h('span', { class: 'muted small' }, `${atts.length} attachment${atts.length > 1 ? 's' : ''}`),
    atts.map(a => h('span', { class: 'att', title: `${a.filename}\n${a.mimeType}\n${U.fmtSize(a.size)}` },
      h('span', { class: 'aname' }, a.filename), h('span', { class: 'muted small' }, U.fmtSize(a.size)),
      h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'save', att: a.i }), 'aria-label': `Save ${a.filename}` }, 'Save')))) : null;
  const body = h('div', { class: 'view' });
  msgPane.append(card, attBar || '', tabs, body);
  renderTab(body);
}

function setTab(id) {
  S.ui.tab = id;
  for (const b of msgPane.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  const body = msgPane.querySelector('.view');
  if (body) renderTab(body);
}

function imagesBar(stats) {
  if (remoteOn) return h('div', { class: 'imgbar on' }, 'Remote images are shown in this tab. Loading them tells the sender that the message was opened.',
    h('button', { onclick: () => reload('blockImages') }, 'Block again'));
  if (!stats.remote) return null;
  return h('div', { class: 'imgbar' }, `${stats.remote} remote image${stats.remote > 1 ? 's' : ''} blocked. They can tell the sender that you opened the message.`,
    h('button', { onclick: () => reload('showImages') }, 'Show images'));
}
function reload(type) { vscode.postMessage({ type, ui: S.ui }); }

function pre(text, cls) { return h('pre', { class: cls || 'textview' }, text); }

function renderTab(body) {
  const m = S.msg;
  body.textContent = '';
  frame = null;
  const tab = S.ui.tab;
  if (tab === 'html') {
    if (!m.html) { body.append(h('div', { class: 'note muted' }, 'This message has no HTML part. Showing the plain text.'), pre(m.text || '(empty message)')); done(); return; }
    const res = sanitizeEmailHtml(m.html, { cid: m.cid, allowRemote: remoteOn, parse });
    const bar2 = imagesBar(res.stats);
    if (bar2) body.append(bar2);
    frame = h('iframe', { class: 'mailframe', sandbox: 'allow-same-origin', title: 'Message body', referrerpolicy: 'no-referrer' });
    frame.srcdoc = res.html;
    frame.addEventListener('load', () => {
      const d = frame.contentDocument;
      if (!d) return;
      d.addEventListener('click', e => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') || '';
        if (/^\s*#/.test(href)) { const t = d.getElementById(href.trim().slice(1)) || d.querySelector(`[name="${CSS.escape(href.trim().slice(1))}"]`); if (t) t.scrollIntoView(); return; }
        if (/^\s*(https?:|mailto:)/i.test(href)) vscode.postMessage({ type: 'openLink', url: href.trim() });
      }, true);
      d.addEventListener('submit', e => e.preventDefault(), true);
      done();
    });
    body.append(frame);
    body.dataset.remote = String(res.stats.remote);
    body.dataset.cid = String(res.stats.cid);
    return;
  }
  if (tab === 'text') {
    const t = m.text || (m.html ? U.htmlToText(m.html, parse) : '');
    if (!m.text && m.html) body.append(h('div', { class: 'note muted' }, 'This message has no text part. This text was made from the HTML.'));
    body.append(pre(t || '(empty message)'));
  } else if (tab === 'source') {
    body.append(h('div', { class: 'note muted' }, `${U.fmtSize(m.rawSize)} raw message${m.rawTruncated ? `. The first ${U.fmtSize(m.raw.length)} are shown; use Open as text for the rest` : ''}.`,
      h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'copy', text: m.raw }) }, 'Copy')), pre(m.raw, 'textview source'));
  } else if (tab === 'headers') {
    body.append(h('div', { class: 'note muted' }, `${m.headerCount} header lines${m.headerCount > m.headers.length ? ` (first ${m.headers.length} shown)` : ''}.`,
      h('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'copy', text: m.headers.map(x => `${x.name}: ${x.value}`).join('\n') }) }, 'Copy')),
    h('table', { class: 'kv headers' }, m.headers.map(x => h('tr', null, h('th', null, x.name), h('td', null, x.value)))));
  } else if (tab === 'auth') {
    renderAuth(body, m.auth);
  } else if (tab === 'route') {
    renderRoute(body, m.hops);
  }
  done();
}

function renderAuth(body, a) {
  const s = a.summary;
  body.append(h('div', { class: 'authgrid' }, [['SPF', s.spf, 'Was the sending server allowed to send for the envelope domain?'], ['DKIM', s.dkim, 'Did a domain sign the message, and did the signature match?'], ['DMARC', s.dmarc, 'Does the From domain line up with a passing SPF or DKIM result?']].map(([k, r, q]) =>
    h('div', { class: `authcard ${U.resultClass(r && r.result)}` }, h('div', { class: 'ak' }, k), h('div', { class: 'ar' }, r ? r.result.toUpperCase() : 'NOT RECORDED'), h('div', { class: 'small' }, U.authDetail(r)), h('div', { class: 'small muted' }, q)))));
  body.append(h('p', { class: 'note muted' }, 'These are the results the receiving mail server wrote into the headers. EML Viewer shows them as recorded; it does not look up DNS or check signatures again, so it works offline.'));
  if (!a.results.length && !a.receivedSpf.length) body.append(h('p', { class: 'note' }, 'This message has no Authentication-Results header. Messages saved from a Sent folder or written by a script often have none.'));
  a.results.forEach((r, n) => {
    body.append(h('h3', null, `Authentication-Results ${n + 1}${r.serv ? ` · ${r.serv}` : ''}${n === 0 ? ' (newest)' : ''}`),
      h('table', { class: 'kv' }, r.results.map(x => h('tr', null, h('th', null, x.method), h('td', null, h('span', { class: `pill ${U.resultClass(x.result)}` }, x.result), ' ', Object.entries(x.props).map(([k, v]) => `${k}=${v}`).join('  '), x.comment ? ` (${x.comment})` : '')))));
  });
  if (a.dkimSignatures.length) body.append(h('h3', null, 'DKIM signatures in the message'), h('table', { class: 'kv' }, a.dkimSignatures.map(d => h('tr', null, h('th', null, `d=${d.d}`), h('td', null, `selector ${d.s || '?'} · ${d.a || '?'} · signs ${d.h} headers`)))));
  if (a.receivedSpf.length) body.append(h('h3', null, 'Received-SPF'), ...a.receivedSpf.map(r => pre(r.text, 'textview small')));
  if (a.arcSeals.length) body.append(h('h3', null, 'ARC chain'), h('table', { class: 'kv' }, a.arcSeals.map(x => h('tr', null, h('th', null, `i=${x.i}`), h('td', null, `cv=${x.cv || '?'} · ${x.d}`)))));
}

function renderRoute(body, hops) {
  if (!hops.length) { body.append(h('p', { class: 'note' }, 'This message has no Received headers.')); return; }
  const first = hops.find(x => x.date !== null), last = [...hops].reverse().find(x => x.date !== null);
  const total = first && last ? Math.round((last.date - first.date) / 1000) : null;
  body.append(h('p', { class: 'note muted' }, `${hops.length} hops, oldest first.${total !== null ? ` Total time in transit: ${U.fmtDelay(total).replace('+', '')}.` : ''} Hostnames and IPs are as each server wrote them.`));
  body.append(h('ol', { class: 'hops' }, hops.map((x, i) => h('li', { class: 'hop' },
    h('div', { class: 'hl' }, h('span', { class: 'hn' }, String(i + 1)), h('b', null, x.from || '(unknown)'), x.ip ? h('span', { class: 'muted' }, ` [${x.ip}]`) : '', ' → ', h('b', null, x.by || '(unknown)')),
    h('div', { class: 'small' }, [x.with ? `with ${x.with}` : '', x.tls ? 'TLS' : '', x.id ? `id ${x.id}` : ''].filter(Boolean).join(' · '), x.date !== null ? h('span', { class: 'muted' }, ` · ${new Date(x.date).toLocaleString()}`) : '',
      x.delay !== null ? h('span', { class: `delay${x.delay > 300 || x.delay < 0 ? ' slow' : ''}` }, ` ${U.fmtDelay(x.delay)}`) : ''),
    h('details', null, h('summary', { class: 'small muted' }, 'Raw header'), pre(x.raw, 'textview small'))))));
}

function done() {
  const m = S.msg;
  setStatus(`${S.kind === 'mbox' ? `Message ${S.index + 1} · ` : ''}${U.fmtSize(m.rawSize)} · parsed in ${m.parseMs} ms`, undefined);
  if (!S.rendered) { S.rendered = true; vscode.postMessage({ type: 'rendered' }); }
}

function notice(text, cls) {
  const n = h('div', { class: `notice ${cls || ''}` }, text);
  return n;
}

let toastTimer = 0;
function toast(text, err) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = text; t.classList.toggle('error', !!err); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------- host messages ----------
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') {
    S.kind = m.kind; S.name = m.name;
    if (m.ui) S.ui = Object.assign(S.ui, m.ui);
    if (typeof m.current === 'number') S.index = m.current;
    app.textContent = '';
    titleEl.textContent = m.name;
    infoEl.textContent = `${m.kind === 'mbox' ? 'Mailbox' : 'Message'} · ${m.sizeText}`;
    app.append(bar, main, status);
    if (!m.plan.open) { msgPane.append(notice(m.plan.message, 'error big')); return; }
    if (m.kind === 'mbox') {
      listPane.hidden = false; main.classList.add('split');
      search.value = S.ui.query;
      sortSel.value = String(Math.max(0, U.SORT_OPTIONS.findIndex(([k, d]) => k === S.ui.sort && d === S.ui.desc)));
      setStatus('Indexing...', '');
    }
    msgPane.append(h('p', { class: 'loading' }, m.kind === 'mbox' ? 'Indexing the mailbox...' : 'Reading the message...'));
    return;
  }
  if (m.type === 'index') {
    S.done = m.done;
    const pct = m.size ? Math.round((m.scanned / m.size) * 100) : 100;
    setStatus(undefined, m.done ? `${m.total.toLocaleString()} messages · indexed in ${m.ms < 1000 ? `${m.ms} ms` : `${(m.ms / 1000).toFixed(1)} s`}` : `Indexing... ${m.total.toLocaleString()} messages · ${pct}%`);
    if (m.done || S.rows.length < PAGE) requestPage();
    return;
  }
  if (m.type === 'page') {
    if (m.req !== S.req) return;
    S.rows = m.rows; S.total = m.total; S.all = m.all;
    renderList();
    if (S.index === null && S.rows.length) openRow(S.rows[0].i);
    else if (S.openEdge && S.rows.length) { openRow(S.openEdge > 0 ? S.rows[0].i : S.rows[S.rows.length - 1].i); S.openEdge = 0; }
    return;
  }
  if (m.type === 'message') {
    S.msg = m.model; S.index = m.index;
    if (S.kind === 'mbox') for (const el of listEl.children) el.setAttribute('aria-selected', String(Number(el.dataset.i) === m.index));
    renderMessage();
    return;
  }
  if (m.type === 'saved') { toast(m.cancelled ? 'Save cancelled.' : `Saved ${U.fmtSize(m.bytes)} to ${m.path}`); return; }
  if (m.type === 'copied') { toast('Copied to the clipboard.'); return; }
  if (m.type === 'error') {
    if (m.soft || S.msg) { toast(m.message, true); setStatus(m.message); return; }
    msgPane.textContent = ''; msgPane.append(notice(m.message, 'error'));
    if (!app.contains(main)) { app.textContent = ''; app.append(bar, main, status); }
  }
});

vscode.postMessage({ type: 'ready' });
