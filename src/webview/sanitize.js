'use strict';
// Prepares message HTML for the sandboxed iframe. The iframe has no allow-scripts and inherits the webview CSP, so
// scripts and remote loads are already blocked; this pass also removes what could navigate the frame or leak a request
// (meta refresh, base, link, frames, forms), swaps cid: images for the attached data, and counts remote images so the
// "Show images" bar can say how many there are.

const REMOTE_RE = /^\s*(?:https?:)?\/\//i;
const BAD_URL_RE = /^\s*(?:javascript|vbscript|data:text\/html|file):/i;
const DROP_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'portal', 'template', 'audio', 'video', 'source', 'track'];
const URL_ATTRS = ['src', 'background', 'poster', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'lowsrc', 'dynsrc'];

function isRemote(u) { return REMOTE_RE.test(String(u || '')); }

function cidOf(u) {
  const m = /^\s*cid:(.+)$/i.exec(String(u || ''));
  if (!m) return '';
  let v = m[1].trim();
  try { v = decodeURIComponent(v); } catch { /* keep as is */ }
  return v.replace(/^<|>$/g, '').toLowerCase();
}

/**
 * Rewrites url(...) and @import in CSS text. cid: URLs become data URLs; remote URLs are counted and, when
 * remote images are blocked, replaced so the browser does not try them (CSP would block them anyway).
 */
function rewriteCss(css, cid, allowRemote, stats) {
  let out = String(css).replace(/@import\s+[^;]+;?/gi, () => { stats.removed++; return ''; });
  out = out.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, q, u) => {
    const c = cidOf(u);
    if (c) { if (cid[c]) { stats.cid++; return `url("${cid[c]}")`; } stats.cidMissing++; return 'none'; }
    if (isRemote(u)) { stats.remote++; return allowRemote ? all : 'none'; }
    if (BAD_URL_RE.test(u)) { stats.removed++; return 'none'; }
    return all;
  });
  return out;
}

/** Remote URLs in a srcset value. */
function srcsetUrls(v) {
  return String(v || '').split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
}

const BASE_CSS = 'html{background:#fff;color:#1f1f1f}body{margin:12px 16px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{cursor:pointer}img.blocked{outline:1px dashed #b0b0b0;min-width:16px;min-height:16px;background:#f2f2f2}pre{white-space:pre-wrap}';

/**
 * @param {string} html message HTML
 * @param {{cid: Object<string,string>, allowRemote: boolean, parse: (s:string)=>Document}} o
 * @returns {{html: string, stats: {remote:number, cid:number, cidMissing:number, removed:number, links:number}}}
 */
function sanitizeEmailHtml(html, o) {
  const stats = { remote: 0, cid: 0, cidMissing: 0, removed: 0, links: 0 };
  // <base> is dropped before parsing too: the parsed document inherits the webview CSP, which would log the blocked base URL
  const doc = o.parse(String(html || '').replace(/<base\b[^>]*>/gi, () => { stats.removed++; return ''; }));
  for (const t of DROP_TAGS) for (const el of [...doc.querySelectorAll(t)]) { el.remove(); stats.removed++; }
  for (const el of [...doc.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) { el.removeAttribute(a.name); stats.removed++; continue; }
      if (n === 'style') { el.setAttribute('style', rewriteCss(a.value, o.cid, o.allowRemote, stats)); continue; }
      if (!URL_ATTRS.includes(n)) continue;
      const v = a.value;
      if (n === 'href' || n === 'xlink:href') {
        if (el.tagName.toLowerCase() === 'a' && /^\s*(https?:|mailto:)/i.test(v)) { stats.links++; continue; }
        if (el.tagName.toLowerCase() === 'a' && /^\s*#/.test(v)) continue;
        if (isRemote(v)) { stats.remote++; if (!o.allowRemote) el.removeAttribute(a.name); continue; }
        if (BAD_URL_RE.test(v) || !/^\s*(cid:|data:image\/)/i.test(v)) { el.removeAttribute(a.name); stats.removed++; }
        continue;
      }
      if (n === 'action' || n === 'formaction') { el.removeAttribute(a.name); stats.removed++; continue; }
      if (n === 'srcset') {
        const urls = srcsetUrls(v);
        const remote = urls.filter(isRemote).length;
        stats.remote += remote;
        if (remote && !o.allowRemote) { el.setAttribute('data-blocked-srcset', v); el.removeAttribute('srcset'); }
        continue;
      }
      const c = cidOf(v);
      if (c) {
        if (o.cid[c]) { el.setAttribute(a.name, o.cid[c]); stats.cid++; } else { el.removeAttribute(a.name); stats.cidMissing++; }
        continue;
      }
      if (isRemote(v)) {
        stats.remote++;
        if (!o.allowRemote) { el.setAttribute('data-blocked-' + n, v); el.removeAttribute(a.name); if (n === 'src') el.classList.add('blocked'); }
        continue;
      }
      // a relative URL means nothing in a saved message and would resolve against the webview; keep only inline images
      if (!/^\s*data:image\//i.test(v)) { el.removeAttribute(a.name); stats.removed++; }
    }
  }
  for (const s of [...doc.querySelectorAll('style')]) s.textContent = rewriteCss(s.textContent, o.cid, o.allowRemote, stats);
  const head = doc.head || doc.documentElement;
  const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8');
  const base = doc.createElement('style'); base.textContent = BASE_CSS;
  head.insertBefore(base, head.firstChild);
  head.insertBefore(meta, head.firstChild);
  return { html: '<!DOCTYPE html>' + doc.documentElement.outerHTML, stats };
}

module.exports = { sanitizeEmailHtml, rewriteCss, isRemote, cidOf, srcsetUrls, DROP_TAGS };
