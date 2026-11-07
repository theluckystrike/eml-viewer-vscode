# Changelog

## Unreleased

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.1 (2026-11-06)

- The status line at the bottom of the viewer has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `emlViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "EML Viewer: Support the developer" and "EML Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- Links inside an email still open only http, https and mailto addresses. The support links sit outside the message frame.
- The listing gets a Sponsor button and a description without a colon. The README has a short Support section and lists all Zovo extensions.
- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 11 that are coming soon.
- Extensions for related files now come first, starting with PDF Viewer & PDF Reader with Dark Mode and DOCX Viewer & Word Viewer with Dark Mode.

## 0.1.0

- First release. Opens .eml, .emlx, .mbox and .mbx files in a read-only viewer.
- HTML body in a sandboxed frame, remote images blocked until you click Show images, inline cid images, plain text and raw source.
- Attachment list with Save. SPF, DKIM and DMARC badges, an Authentication tab and a Route tab with the Received hops.
- Mailboxes are indexed as a stream, with search, sort and pages of 200 messages. Files over 4 GB show a message.
- One-time rating prompt after a few days of use (setting emlViewer.askForRating).
