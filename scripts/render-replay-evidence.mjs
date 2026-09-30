// Self-contained local evidence viewer. Escapes every recorded byte; no scripts,
// external resources, inferred pass scores, or execution of generated actions.
import fs from 'node:fs';
import path from 'node:path';

const [destination, ...directories] = process.argv.slice(2).map(file => path.resolve(file));
if (!destination || !directories.length) throw Error('Usage: node render-replay-evidence.mjs OUTPUT.html RECORD_DIR...');
if (fs.existsSync(destination)) throw Error('Refusing to overwrite an existing evidence page');
const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function entries(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Evidence symlink not followed: ${file}`);
    if (entry.isDirectory()) return entries(file, relative);
    if (!entry.isFile() || !/\.(?:json|jsonl|body|md)$/.test(entry.name)) return [];
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw Error(`Unexpectedly large replay record: ${file}`);
    let text = fs.readFileSync(file, 'utf8');
    if (/\.json$/.test(file)) try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* preserve raw invalid evidence */ }
    return [{ relative, text }];
  });
}
const sections = directories.map((directory, i) => {
  const records = entries(directory);
  const featured = records.filter(record => /(?:summary|scope|review)\.json$/.test(record.relative) && !record.relative.includes(path.sep));
  return `<section id="round-${i + 1}"><div class="round">ROUND ${i + 1} · DIAGNOSTIC REPLAY</div><h2>${escape(path.basename(directory))}</h2>`
    + `<p class="path">${escape(directory)}</p>`
    + featured.map(record => `<details open><summary>${escape(record.relative)}</summary><pre>${escape(record.text)}</pre></details>`).join('')
    + `<h3>Complete recorded context · ${records.length} files</h3>`
    + records.map(record => `<details><summary>${escape(record.relative)}</summary><pre>${escape(record.text)}</pre></details>`).join('') + '</section>';
});
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bantam Factory — disputed-check repair evidence</title><style>
:root{color-scheme:dark}body{margin:0;background:#10141b;color:#e6edf3;font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:36px 22px}header{border-top:5px solid #f4b44c;padding:22px 0}h1{font-size:clamp(28px,5vw,46px);line-height:1.1}h2{overflow-wrap:anywhere}p{max-width:85ch}.round{color:#f4b44c;font-weight:800;letter-spacing:.08em}section{margin-top:34px;border:1px solid #364151;border-radius:12px;padding:22px;background:#151c26}.path{color:#a6b3c2;font-size:13px;overflow-wrap:anywhere}details{border-top:1px solid #364151;padding:12px 0}summary{cursor:pointer;color:#aedbff;font-weight:650;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,monospace;background:#0c1119;border-radius:6px;padding:14px}.notice{padding:16px;border-left:4px solid #f4b44c;background:#242018}a{color:#aedbff}</style>
<main><header><div class="round">BANTAM FACTORY · THE REVIEW BOOTH</div><h1>One disputed decision.<br>Every recorded exchange.</h1>
<p class="notice">These are isolated diagnostic replays, not a completed benchmark run. Generated worker actions were not executed. Reviewer verdicts are model opinions, not passing execution receipts; a correct verdict can still contain faulty reasoning.</p>
<p>The continuity comparison restores only the worker's own preceding note. The assertion comparison supplies public requirements and the script, selecting the exact failed assertion without revealing implementation or runtime values. The control selects a neighboring assertion independently.</p>
<nav>${directories.map((directory, i) => `<a href="#round-${i + 1}">Round ${i + 1}</a>`).join(' · ')}</nav></header>${sections.join('')}</main></html>`;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, html);
console.log(JSON.stringify({ destination, bytes: Buffer.byteLength(html), records: directories.length }));
