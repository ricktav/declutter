#!/usr/bin/env node
// Render a status markdown file into one self-contained HTML page:
//   node scripts/render-status.mjs docs/status-2026-10-03.md
// Writes the .html next to it. Relative PNG/JPEG images are inlined as data:
// URIs and the stylesheet is inline, so the page fetches nothing when viewed
// and can be served from anywhere (or opened as a file).
import fs from "fs";
import path from "path";
import { marked } from "marked";

const src = process.argv[2];
if (!src || !src.endsWith(".md")) {
  console.error("usage: node scripts/render-status.mjs <file.md>");
  process.exit(2);
}
const md = fs.readFileSync(src, "utf8");
const title = (md.match(/^# (.+)$/m)?.[1] ?? "Status").trim();
const dir = path.dirname(src);
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const body = marked.parse(md).replace(/<img src="([^"]+)"/g, (_m, ref) => {
  if (/^[a-z]+:/i.test(ref)) throw new Error(`external image not allowed in a self-contained page: ${ref}`);
  const file = path.resolve(dir, decodeURIComponent(ref));
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type || !fs.existsSync(file)) throw new Error(`image missing or not PNG/JPEG: ${ref}`);
  return `<img src="data:${type};base64,${fs.readFileSync(file).toString("base64")}"`;
});

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { --bg: #f6f6f1; --fg: #23261c; --muted: #5f6452; --line: #d5d9cd; --card: #ffffff; --accent: #3c5d41; --code: #eceee5; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #1b1d16; --fg: #e8eadf; --muted: #a9ae9a; --line: #3a3f2e; --card: #23261c; --accent: #b8d98a; --code: #2c3024; }
}
:root[data-theme="dark"] { --bg: #1b1d16; --fg: #e8eadf; --muted: #a9ae9a; --line: #3a3f2e; --card: #23261c; --accent: #b8d98a; --code: #2c3024; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 16px; margin: 24px 0 8px; }
p, li { color: var(--fg); }
a { color: var(--accent); }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; overflow-wrap: anywhere; }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { display: block; overflow-x: auto; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--card); }
img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
blockquote { margin: 12px 0; padding: 4px 14px; border-left: 3px solid var(--accent); color: var(--muted); }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
const out = src.replace(/\.md$/, ".html");
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${Buffer.byteLength(html)} bytes)`);
