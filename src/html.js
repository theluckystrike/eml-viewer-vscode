'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
// The message HTML is shown in a sandboxed srcdoc iframe, which inherits this policy: scripts need our nonce, so no
// script in a message can run, and remote images load only when remoteImages is true (after the user clicks).
const crypto = require('crypto');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCsp(cspSource, nonce, remoteImages) {
  return [
    "default-src 'none'",
    // 'unsafe-inline' styles are for the message HTML (inline style attributes and <style> blocks); scripts stay nonce-only
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:${remoteImages ? ' https: http:' : ''}`,
    `font-src ${cspSource} data:`,
    "frame-src 'self' about:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string, remoteImages?:boolean}} p */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const csp = buildCsp(p.cspSource, n, !!p.remoteImages);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app" data-remote="${p.remoteImages ? '1' : '0'}"><p class="loading">Reading the message...</p></div>
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, buildCsp, escapeAttr };
