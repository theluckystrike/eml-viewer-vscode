// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, records every network request made by the webview,
// saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null, network: [] };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
// record every request the webview frames make (http/https only; webview resources come from vscode-cdn.net)
const netEnabled = new Set();
vs.s.on(m => {
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/^https?:/.test(u) && !/vscode-cdn\.net|vscode-resource/.test(u)) R.network.push({ url: u.slice(0, 200), t: Date.now(), step: R.steps.length });
  }
});
const enableNet = async () => { for (const [sid, info] of vs.attached) if (info.type === 'iframe' && !netEnabled.has(sid)) { netEnabled.add(sid); await vs.s.send('Network.enable', {}, sid).catch(() => {}); } };
const shots = [];
const shot = async name => { const f = path.join(shotDir, `eml-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 500), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 20000);
const open = async file => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); await enableNet(); return Date.now() - t0; };
const refreshWv = async file => { wv = await getWv(file); await enableNet(); };
const shown = () => vs.waitFor(() => E(`!!document.querySelector('.card .subject') && document.querySelector('.card .subject').textContent`), 20000, 150);
const frameReady = () => vs.waitFor(() => E(`(() => { const f = document.querySelector('iframe.mailframe'); return !!(f && f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.body && f.contentDocument.body.childElementCount); })()`), 15000, 150);
const tab = async id => { await vs.wvClick(wv, `document.querySelector('.tabs button[data-tab="${id}"]')`); await sleep(300); };
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const viewText = () => E(`document.querySelector('.view').innerText`);
const saveDialog = async target => {
  await sleep(1200);
  const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
  await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(target);
  await sleep(300); await vs.key('Enter', 'Enter'); await sleep(1200);
};

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('newsletter.eml opens as the default editor: header card, auth badges, cid images, remote images blocked, no network', async () => {
    const ms = await open('newsletter.eml');
    const subject = await shown(); if (!subject) throw new Error('no message');
    await frameReady(); await sleep(800);
    const card = await E(`document.querySelector('.card').innerText`);
    const badges = await E(`[...document.querySelectorAll('.badge')].map(b => b.className + ':' + b.textContent).join(' | ')`);
    const bar = await E(`(document.querySelector('.imgbar') || {}).textContent || ''`);
    const fr = JSON.parse(await E(`(() => { const d = document.querySelector('iframe.mailframe').contentDocument; const imgs = [...d.images]; return JSON.stringify({ sandbox: document.querySelector('iframe.mailframe').getAttribute('sandbox'), cidLoaded: imgs.filter(i => i.src.startsWith('data:') && i.naturalWidth > 0).length, withRemoteSrc: imgs.filter(i => /^https?:/.test(i.getAttribute('src') || '')).length, blocked: imgs.filter(i => i.dataset.blockedSrc).length }); })()`));
    const atts = await E(`[...document.querySelectorAll('.att .aname')].map(a => a.textContent).join(', ')`);
    await shot('newsletter');
    const net = R.network.filter(n => n.step === R.steps.length);
    if (!/pass/.test(badges) || fr.cidLoaded !== 2 || fr.withRemoteSrc !== 0 || !/3 remote images blocked/.test(bar) || net.length || fr.sandbox !== 'allow-same-origin') throw new Error(JSON.stringify({ badges, fr, bar, net }));
    return { openMs: ms, subject, badges, frame: fr, imagesBar: bar, attachments: atts, networkRequests: net.length, card: card.split('\n').slice(0, 4).join(' / ') };
  });
  await step('Show images reloads with remote images allowed; Block again blocks them', async () => {
    const n0 = R.network.length;
    await vs.wvClick(wv, btn('Show images')); await sleep(1500);
    await refreshWv('newsletter.eml'); await shown(); await frameReady(); await sleep(1500);
    const bar = await E(`document.querySelector('.imgbar').textContent`);
    const remoteSrc = await E(`[...document.querySelector('iframe.mailframe').contentDocument.images].filter(i => /^https:/.test(i.getAttribute('src') || '')).length`);
    const reqs = R.network.slice(n0).map(n => n.url);
    await vs.wvClick(wv, btn('Block again')); await sleep(1500);
    await refreshWv('newsletter.eml'); await shown(); await frameReady();
    const bar2 = await E(`document.querySelector('.imgbar').textContent`);
    if (!/shown in this tab/.test(bar) || remoteSrc < 2 || !/blocked/.test(bar2)) throw new Error(JSON.stringify({ bar, remoteSrc, bar2 }));
    return { afterShow: bar.slice(0, 60), remoteImgElements: remoteSrc, requestsAfterClick: reqs.slice(0, 5), afterBlock: bar2.slice(0, 40) };
  });
  await step('a link click in the message asks first (modal), Cancel opens nothing', async () => {
    const off = await vs.wvOffset();
    const fb = JSON.parse(await E(`JSON.stringify(document.querySelector('iframe.mailframe').getBoundingClientRect())`));
    const lb = JSON.parse(await E(`(() => { const d = document.querySelector('iframe.mailframe').contentDocument; const a = [...d.querySelectorAll('a')].find(x => /changelog/.test(x.href)); a.scrollIntoView({ block: 'center' }); return JSON.stringify(a.getBoundingClientRect()); })()`));
    await vs.click(off.x + fb.x + lb.x + lb.width / 2, off.y + fb.y + lb.y + lb.height / 2); await sleep(800);
    const dlg = await vs.waitFor(() => vs.wbEval(`(document.querySelector('.monaco-dialog-box') || {}).innerText || ''`), 5000);
    await shot('link-confirm');
    await vs.wbEval(`[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => /Cancel/.test(b.textContent)).click()`); await sleep(500);
    const still = await vs.wbEval(`!!document.querySelector('.monaco-dialog-box')`);
    if (!/changelog\/2026-10/.test(dlg || '') || still) throw new Error(JSON.stringify({ dlg, still }));
    return dlg.replace(/\s+/g, ' ').slice(0, 160);
  });
  await step('Save an attachment through the save dialog', async () => {
    const target = path.join(work, 'saved-signups.csv'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, `[...document.querySelectorAll('.att')].find(a => /signups/.test(a.textContent)).querySelector('button')`);
    await saveDialog(target);
    const ok = await vs.waitFor(() => fs.existsSync(target), 6000);
    if (!ok) { await shot('save-dialog'); await vs.key('Escape', 'Escape'); throw new Error('no file'); }
    const text = fs.readFileSync(target, 'utf8');
    if (!/^month,signups,churn\n2026-05,1204/.test(text)) throw new Error(text.slice(0, 80));
    return { bytes: text.length, toast: await E(`(document.querySelector('.toast') || {}).textContent || ''`) };
  });
  await step('Text, Headers and Source tabs', async () => {
    await tab('text'); const t = await viewText();
    await tab('headers'); const hd = await viewText();
    await tab('source'); const src = await viewText();
    await tab('html');
    if (!/Faster dashboards/.test(t) || !/DKIM-Signature/.test(hd) || !/Content-Type: multipart\/mixed/.test(src)) throw new Error(JSON.stringify([t.slice(0, 80), hd.slice(0, 80), src.slice(0, 80)]));
    return { text: t.slice(0, 50), headers: hd.split('\n')[0], source: src.split('\n')[0] };
  });
  await step('spoofed invoice: SPF fail, DKIM none, DMARC fail; Authentication tab and Route with a slow hop', async () => {
    await open('invoice-spf-fail.eml'); await shown();
    await tab('auth'); await sleep(300);
    const auth = await viewText();
    await shot('auth-spf-fail');
    await tab('route'); const route = await viewText();
    const slow = await E(`[...document.querySelectorAll('.delay.slow')].map(d => d.textContent.trim()).join(',')`);
    await shot('route-hops');
    await tab('html');
    if (/\[object /.test(auth) || !/Received-SPF[\s\S]*client-ip=192\.0\.2\.77/i.test(auth) || !/SPF\s*FAIL/.test(auth) || !/DMARC\s*FAIL/.test(auth) || !/2 hops/.test(route) || slow !== '+9 min 0 s') throw new Error(JSON.stringify({ auth: auth.slice(0, 300), route: route.slice(0, 200), slow }));
    return { auth: auth.split('\n').slice(0, 9).join(' / '), slowHop: slow };
  });
  await step('unsafe HTML: no script, frame, form action, meta refresh or remote load; subject stays text', async () => {
    const n0 = R.network.length;
    await open('unsafe-html.eml'); const subject = await shown(); await frameReady(); await sleep(1000);
    const d = JSON.parse(await E(`(() => { const d = document.querySelector('iframe.mailframe').contentDocument; return JSON.stringify({ title: d.title, scripts: d.querySelectorAll('script').length, iframes: d.querySelectorAll('iframe,object,embed').length, meta: d.querySelectorAll('meta[http-equiv]').length, base: d.querySelectorAll('base').length, formAction: [...d.querySelectorAll('form')].filter(f => f.hasAttribute('action')).length, onAttrs: [...d.querySelectorAll('*')].filter(e => [...e.attributes].some(a => a.name.startsWith('on'))).length, jsLinks: [...d.querySelectorAll('a')].filter(a => /javascript:/i.test(a.getAttribute('href') || '')).length, svgImage: [...d.querySelectorAll('image')].filter(i => i.getAttribute('href')).length, cssRemote: /evil/.test([...d.querySelectorAll('style')].map(s => s.textContent).join('')) }); })()`));
    const bar = await E(`(document.querySelector('.imgbar') || {}).textContent || ''`);
    await shot('unsafe-html');
    const net = R.network.slice(n0).filter(n => /evil/.test(n.url));
    const dialogs = await vs.wbEval(`!!document.querySelector('.monaco-dialog-box')`);
    const relImg = await E(`[...document.querySelector('iframe.mailframe').contentDocument.images].filter(i => i.getAttribute('src') === 'x').length`);
    if (relImg || subject !== '<img src=x onerror=alert(1)> unsafe HTML test' || d.scripts || d.iframes || d.meta || d.base || d.formAction || d.onAttrs || d.jsLinks || d.svgImage || d.cssRemote || net.length || dialogs) throw new Error(JSON.stringify({ subject, d, net, dialogs }));
    return { subject, frame: d, imagesBar: bar, evilRequests: net.length };
  });
  await step('encoded headers (RFC 2047, UTF-8 QP) and .emlx', async () => {
    await open('encoded-headers.eml'); const s1 = await shown();
    const card = await E(`document.querySelector('.card').innerText`);
    await open('apple-mail.emlx'); const s2 = await shown();
    if (s1 !== 'Résumé de la réunion – 東京 & Zürich' || !/田中 花子/.test(card) || s2 !== 'Apple Mail copy of the meeting notes') throw new Error(JSON.stringify({ s1, s2, card }));
    return { eml: s1, emlx: s2 };
  });
  await step('team-inbox.mbox: list of 2,500, search, sort, open, arrow keys, next page', async () => {
    const t0 = Date.now();
    await open('team-inbox.mbox');
    await vs.waitFor(() => E(`document.querySelectorAll('.row').length >= 200`), 15000);
    const firstRows = Date.now() - t0;
    await shown();
    const status = await vs.waitFor(() => E(`(() => { const t = document.querySelector('.stat-right').textContent; return /indexed/.test(t) && t; })()`), 15000);
    const pager = await E(`document.querySelector('.pagerlabel').textContent`);
    await vs.wvClick(wv, `document.querySelector('input[type=search]')`); await vs.type('lunch'); await sleep(900);
    const searched = await E(`document.querySelector('.pagerlabel').textContent`);
    await vs.wvClick(wv, `[...document.querySelectorAll('input[type=search]')][0]`); await vs.key('a', 'KeyA', 4, 65); await vs.key('Backspace', 'Backspace'); await sleep(900);
    await E(`(() => { const s = document.querySelector('select[aria-label="Sort messages"]'); s.value = '1'; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(800);
    const dates = await E(`[...document.querySelectorAll('.row .date')].slice(0, 5).map(d => d.textContent)`);
    await vs.wvClick(wv, `document.querySelectorAll('.row')[2]`); await sleep(800);
    const subj1 = await shown();
    await vs.key('ArrowDown', 'ArrowDown'); await sleep(900);
    const sel = await E(`[...document.querySelectorAll('.row')].findIndex(r => r.getAttribute('aria-selected') === 'true')`);
    await shot('mbox-inbox');
    await vs.wvClick(wv, btn('Next')); await sleep(800);
    const pager2 = await E(`document.querySelector('.pagerlabel').textContent`);
    if (!/of 2,500/.test(pager) || !/of 2,500\)/.test(searched) || sel !== 3 || !/^201-400 of 2,500/.test(pager2) || !(dates[0] >= dates[1])) throw new Error(JSON.stringify({ pager, searched, sel, pager2, dates }));
    return { firstRowsMs: firstRows, status, pager, search: searched, newestFirst: dates.slice(0, 3), opened: subj1, page2: pager2 };
  });
  await step('big mailbox (about 45 MB, 39,000 messages): first rows fast, VS Code stays responsive', async () => {
    const t0 = Date.now();
    await open('big-archive.mbox');
    await vs.waitFor(() => E(`document.querySelectorAll('.row').length > 0`), 20000);
    const first = Date.now() - t0;
    let worst = 0;
    const until = Date.now() + 30000;
    let status = '';
    while (Date.now() < until) {
      const a = Date.now(); await vs.wbEval('1'); worst = Math.max(worst, Date.now() - a);
      status = await E(`document.querySelector('.stat-right').textContent`);
      if (/indexed/.test(status)) break;
      await sleep(100);
    }
    await shown();
    if (!/indexed/.test(status) || worst > 500) throw new Error(JSON.stringify({ status, worst }));
    return { firstRowsMs: first, status, workbenchWorstLatencyMs: worst, size: fs.statSync(path.join(ws, 'big-archive.mbox')).size };
  });
  await step('over 4 GB (sparse file): clear message', async () => {
    await open('huge-archive.mbox');
    const t = await vs.waitFor(() => E(`(document.querySelector('.notice') || {}).textContent`), 10000);
    await shot('over-4gb-message');
    if (!/4\.0 GB.*up to 4 GB/.test(t || '')) throw new Error(t);
    return t;
  });
  await step('light theme', async () => {
    await vs.click(700, 17);
    await vs.command('Preferences: Color Theme'); await sleep(500); await vs.type('Light Modern'); await sleep(500); await vs.key('Enter', 'Enter'); await sleep(1500);
    await open('team-inbox.mbox'); await shown(); await sleep(800);
    await shot('mbox-light');
    return true;
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /eml|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code, network: R.network.length }, null, 1));
}
