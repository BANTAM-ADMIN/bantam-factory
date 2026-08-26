import path from "node:path";
import { writeTextAtomic } from "./atomic-file.js";
import { summarizeExperiment } from "./experiment.js";

const PALETTE = Object.freeze([
  "#c7fa62", "#7db6ff", "#d6a8ff", "#ffba6b",
  "#65e6d1", "#ff8fa3", "#ffe071", "#a8b6ff",
]);

export function buildGauntletShowcase(manifest, {
  evidenceHref = "../",
  title = "BANTAM Model Gauntlet",
} = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("gauntlet showcase requires a manifest");
  const totals = summarizeExperiment(manifest);
  const arms = (manifest.spec?.arms ?? []).map((arm, index) => ({
    ...arm,
    totals: totals.arms[arm.name],
    color: PALETTE[index % PALETTE.length],
  }));
  if (!arms.length) throw new Error("gauntlet showcase requires at least one arm");
  const completedRuns = arms.reduce((sum, arm) => sum + arm.totals.tasks, 0);
  const passedRuns = arms.reduce((sum, arm) => sum + arm.totals.passed, 0);
  const strictRuns = arms.reduce((sum, arm) => sum + arm.totals.strict, 0);
  const invalidActions = arms.reduce((sum, arm) => sum + (arm.totals.invalidActions ?? 0), 0);
  const protocolViolations = arms.reduce((sum, arm) => sum + (arm.totals.protocolViolations ?? 0), 0);
  const ranked = [...arms].sort(compareArms);
  const correctnessLeader = ranked[0];
  const fastest = [...arms].sort((a, b) => a.totals.taskMs - b.totals.taskMs)[0];
  const fewestTurns = [...arms].sort((a, b) => a.totals.turns - b.totals.turns)[0];
  const maxTime = Math.max(...arms.map((arm) => arm.totals.taskMs), 1);
  const maxInput = Math.max(...arms.map((arm) => arm.totals.inputTok), 1);
  const fixtureNames = unique(arms.flatMap((arm) => Object.keys(arm.totals.fixtures ?? {})));
  const evidenceRoot = String(evidenceHref).replace(/\/?$/, "/");
  const allPassed = passedRuns === completedRuns && completedRuns > 0;
  const rounds = Number(manifest.spec?.rounds) || 1;
  const runNoun = `${completedRuns} inspectable ${completedRuns === 1 ? "run" : "runs"}`;
  const engineNoun = `${arms.length} reasoning ${arms.length === 1 ? "engine" : "engines"}`;
  const outcomeHeading = allPassed
    ? "Quality tied at the completion bar. Efficiency did not."
    : `${correctnessLeader.name} leads on correctness.`;
  const outcomeCopy = allPassed
    ? "Every completed run passed its hidden contract. Compare time, context, output, reasoning, and agent motion after correctness."
    : `${passedRuns} of ${completedRuns} runs passed. Rankings put hidden-contract correctness first, then strictness, turns, time, and cache-miss input.`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="description" content="Evidence-backed N-model comparison inside the BANTAM coding-agent harness.">
  <title>${escapeHtml(title)} — ${escapeHtml(arms.map((arm) => arm.name).join(", "))}</title>
  <style>
    :root{--bg:#07100f;--panel:#10201de8;--soft:#142723;--ink:#f3f6e9;--muted:#9bb0a8;--faint:#6f837b;--line:#c3dfd224;--good:#74e5ae;--accent:#c7fa62;--accent2:#7db6ff;--warn:#ffba6b;--mono:"SFMono-Regular","Cascadia Code",monospace;--sans:Inter,ui-sans-serif,system-ui,sans-serif}
    html[data-theme="light"]{--bg:#edf1e7;--panel:#fafcf6eb;--soft:#e5ece1;--ink:#14201d;--muted:#536660;--faint:#75877f;--line:#193a3024;--good:#167a4a;--accent:#5d8d0d;--accent2:#256bc4;--warn:#a95808}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 8% 2%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 30rem),radial-gradient(circle at 92% 8%,color-mix(in srgb,var(--accent2) 13%,transparent),transparent 31rem),var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55}body:before{content:"";position:fixed;inset:0;z-index:-1;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(#000,transparent 70%);opacity:.45}.shell{width:min(1280px,calc(100% - 36px));margin:auto}.top{position:sticky;top:0;z-index:10;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(18px)}.top .shell{min-height:62px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{font-weight:800;letter-spacing:-.03em}.brand span{color:var(--accent)}nav{display:flex;gap:5px;flex-wrap:wrap}nav a,button{color:var(--muted);background:transparent;border:1px solid transparent;border-radius:9px;padding:7px 9px;text-decoration:none;font:600 11px var(--mono);cursor:pointer}nav a:hover,button:hover{color:var(--ink);border-color:var(--line);background:var(--panel)}header{padding:86px 0 48px}.kicker{font:700 11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(48px,8vw,102px);line-height:.93;letter-spacing:-.067em;margin:20px 0;max-width:1050px}.gradient{color:transparent;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--warn));background-clip:text}.lead{max-width:900px;color:var(--muted);font-size:clamp(17px,2vw,22px)}.pills{display:flex;flex-wrap:wrap;gap:9px;margin-top:28px}.pill{padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font:600 11px var(--mono);color:var(--muted)}section{padding:46px 0}.heading{display:flex;justify-content:space-between;align-items:end;gap:28px;margin-bottom:22px}.heading h2{font-size:clamp(30px,4vw,52px);letter-spacing:-.045em;line-height:1;margin:8px 0}.heading p{max-width:550px;color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.card,.panel,.step,.insight{border:1px solid var(--line);border-radius:20px;background:var(--panel);box-shadow:0 20px 70px #0003}.card{padding:23px;position:relative;overflow:hidden}.card:before{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:3px;background:var(--arm)}.arm{font:800 12px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--arm)}.score{font-size:52px;font-weight:850;letter-spacing:-.06em;margin:12px 0 0}.score small{font-size:15px;color:var(--muted);letter-spacing:0}.stats{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.stat span{display:block;color:var(--faint);font:650 9px var(--mono);letter-spacing:.1em;text-transform:uppercase}.stat b{font:750 17px var(--mono)}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{padding:26px}.bars{display:grid;gap:18px}.bar-row{display:grid;grid-template-columns:minmax(90px,140px) 1fr 110px;gap:13px;align-items:center}.bar-label{font:750 12px var(--mono);overflow:hidden;text-overflow:ellipsis}.track{height:14px;border-radius:99px;background:var(--soft);overflow:hidden}.fill{height:100%;width:var(--width);background:var(--color);border-radius:inherit}.bar-value{text-align:right;color:var(--muted);font:650 11px var(--mono)}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.step{padding:17px}.step-num{font:800 10px var(--mono);color:var(--accent)}.step h3{font-size:15px;margin:8px 0 5px}.step p{font-size:12px;color:var(--muted);margin:0}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:right;padding:11px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--faint);font:700 9px var(--mono);letter-spacing:.08em;text-transform:uppercase}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.insight{padding:20px}.insight b{display:block;font-size:20px;letter-spacing:-.025em;margin-bottom:6px}.insight p{color:var(--muted);font-size:13px;margin:0}.callout{padding:24px;border-left:3px solid var(--warn);background:var(--panel);border-radius:0 16px 16px 0;color:var(--muted)}.callout strong{color:var(--ink)}.code{padding:20px;border:1px solid var(--line);border-radius:15px;background:#020706;color:#cfddd7;overflow:auto;font:12px/1.7 var(--mono)}.artifacts{display:flex;gap:9px;flex-wrap:wrap}.artifacts a{padding:9px 11px;border:1px solid var(--line);border-radius:10px;color:var(--muted);text-decoration:none;font:650 11px var(--mono)}footer{margin-top:50px;border-top:1px solid var(--line);padding:27px 0 42px;color:var(--faint);font:11px var(--mono)}@media(max-width:850px){.two{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.heading{display:block}.bar-row{grid-template-columns:80px 1fr 82px}}@media(max-width:520px){.shell{width:min(100% - 22px,1280px)}header{padding-top:58px}.flow{grid-template-columns:1fr}.top nav a{display:none}}
  </style>
</head>
<body>
  <div class="top"><div class="shell"><div class="brand">BANTAM <span>×</span> MODELS</div><nav><a href="#results">Results</a><a href="#runs">Runs</a><a href="#system">System</a><a href="#evidence">Evidence</a><button id="theme">Theme</button></nav></div></div>
  <header><div class="shell"><div class="kicker">Model gauntlet · ${escapeHtml(dateOnly(manifest.completedAt))} · frozen evidence</div><h1>One harness.<br><span class="gradient">${escapeHtml(engineNoun)}.</span></h1><p class="lead">${arms.length} isolated arms ran the same ${fixtureNames.length} hidden-contract ${fixtureNames.length === 1 ? "fixture" : "fixtures"} inside BANTAM. Every arm began from identical fixture bytes and was graded outside the model-visible workspace.</p><div class="pills"><span class="pill">${passedRuns}/${completedRuns} passed</span><span class="pill">${strictRuns}/${completedRuns} strict</span><span class="pill">${invalidActions} invalid actions</span><span class="pill">${protocolViolations} protocol violations</span><span class="pill">${rounds} ${rounds === 1 ? "round" : "rounds"}</span></div></div></header>
  <main>
    <section id="results"><div class="shell"><div class="heading"><div><div class="kicker">01 · correctness first</div><h2>${escapeHtml(outcomeHeading)}</h2></div><p>${escapeHtml(outcomeCopy)}</p></div><div class="cards">${ranked.map(armCard).join("")}</div></div></section>
    <section><div class="shell"><div class="two"><div class="panel"><div class="kicker">Wall time after correctness</div><h2>${escapeHtml(fastest.name)} was fastest</h2><div class="bars">${ranked.map((arm) => metricBar(arm, arm.totals.taskMs / maxTime, formatDuration(arm.totals.taskMs))).join("")}</div></div><div class="panel"><div class="kicker">Reported input</div><h2>Context is visible, not guessed</h2><div class="bars">${ranked.map((arm) => metricBar(arm, arm.totals.inputTok / maxInput, formatNumber(arm.totals.inputTok))).join("")}</div></div></div></div></section>
    <section id="runs"><div class="shell"><div class="heading"><div><div class="kicker">02 · task-by-task</div><h2>${escapeHtml(runNoun)}</h2></div><p>Durations include BANTAM tool turns and verification. Every populated cell links to its saved run artifact.</p></div><div class="table-wrap"><table><thead><tr><th>Fixture</th>${ranked.map((arm) => `<th>${escapeHtml(arm.name)} result</th><th>${escapeHtml(arm.name)} turns</th>`).join("")}</tr></thead><tbody>${fixtureNames.map((fixture) => fixtureRow(fixture, ranked, manifest, evidenceRoot)).join("")}</tbody></table></div></div></section>
    <section id="system"><div class="shell"><div class="heading"><div><div class="kicker">03 · constant harness</div><h2>Change the model. Hold the work contract still.</h2></div><p>BANTAM owns action admission, isolated workspaces, verification, evidence, and accounting across every arm.</p></div><div class="flow">${[
      ["Select", "Choose any live Codex alias, local model, provider, and supported reasoning effort explicitly."],
      ["Constrain", "Local actions use GBNF; Codex receives the equivalent closed JSON Schema through app-server."],
      ["Execute", "BANTAM admits one action, applies workspace and shell policy, executes it, and returns the observation."],
      ["Verify", "Public tests, immutable-scope checks, and model-hidden contracts grade the final filesystem."],
      ["Account", "Requests, turns, time, input, cache, output, reasoning, actions, and failures remain inspectable."],
      ["Rank", "Correctness and strictness outrank speed or tokens; efficiency breaks ties only after quality."],
      ["Diagnose", "Saved trajectories expose where models diverged instead of reducing the result to one score."],
      ["Improve", "Findings become falsifiable harness candidates and must earn promotion on held-out evidence."],
    ].map((item, index) => `<article class="step"><div class="step-num">${String(index + 1).padStart(2, "0")}</div><h3>${item[0]}</h3><p>${escapeHtml(item[1])}</p></article>`).join("")}</div></div></section>
    <section><div class="shell"><div class="heading"><div><div class="kicker">04 · measured findings</div><h2>Read the ranking with its boundary.</h2></div></div><div class="insights"><article class="insight"><b>${escapeHtml(correctnessLeader.name)} ranks first.</b><p>${correctnessLeader.totals.passed}/${correctnessLeader.totals.tasks} hidden contracts passed, ${correctnessLeader.totals.strict} strict.</p></article><article class="insight"><b>${escapeHtml(fastest.name)} minimized time.</b><p>${formatDuration(fastest.totals.taskMs)} across ${fastest.totals.tasks} runs.</p></article><article class="insight"><b>${escapeHtml(fewestTurns.name)} minimized motion.</b><p>${fewestTurns.totals.turns} turns and ${fewestTurns.totals.requests} requests.</p></article></div><div class="callout" style="margin-top:14px"><strong>Honest boundary:</strong> ${rounds === 1 ? "This is one stochastic round. Repeat with rotated schedules before treating close results as stable." : `This report aggregates ${rounds} rounds; inspect confidence intervals and trajectory evidence before generalizing beyond these fixtures.`} A faster failing arm never outranks a passing arm.</div></div></section>
    <section id="evidence"><div class="shell"><div class="heading"><div><div class="kicker">05 · provenance</div><h2>Follow the evidence.</h2></div><p>Spec SHA-256: <code>${escapeHtml(manifest.specSha256)}</code>. Experiment: <code>${escapeHtml(manifest.id)}</code>.</p></div><div class="artifacts"><a href="${escapeAttr(evidenceRoot)}manifest.json">Manifest</a><a href="${escapeAttr(evidenceRoot)}summary.md">Generated summary</a><a href="${escapeAttr(evidenceRoot)}ledger.jsonl">Run ledger</a><a href="${escapeAttr(evidenceRoot)}catalog.json">Model catalog</a>${arms.flatMap((arm) => runRows(manifest, arm.name).flatMap((row) => [
      `<a href="${escapeAttr(evidenceRoot + row.artifactPath)}">${escapeHtml(arm.name)} · ${escapeHtml(row.name)}</a>`,
      row.attachmentIndexPath
        ? `<a href="${escapeAttr(evidenceRoot + attachmentHref(row))}">${escapeHtml(arm.name)} · ${escapeHtml(row.name)} attachments</a>`
        : "",
      ...(row.archivedAttachmentFiles ?? []).filter((file) => file.endsWith(".html")).map((file, index) =>
        `<a href="${escapeAttr(evidenceRoot + attachmentFileHref(row, file))}">${escapeHtml(arm.name)} · ${escapeHtml(row.name)} contact ${index + 1}</a>`),
    ])).join("")}</div></div></section>
  </main>
  <footer><div class="shell">BANTAM model gauntlet · generated from immutable run evidence · ${escapeHtml(manifest.id)} · ${rounds === 1 ? "one illustrative round, not a universal ranking" : `${rounds} measured rounds, scoped to these fixtures`}</div></footer>
  <script>(()=>{const r=document.documentElement,b=document.getElementById("theme"),s=localStorage.getItem("gauntlet-theme");if(s)r.dataset.theme=s;b.addEventListener("click",()=>{r.dataset.theme=r.dataset.theme==="dark"?"light":"dark";localStorage.setItem("gauntlet-theme",r.dataset.theme)})})();</script>
</body></html>`;
}

export function writeGauntletShowcase(filePath, manifest, options = {}) {
  return writeTextAtomic(path.resolve(filePath), buildGauntletShowcase(manifest, options));
}

function compareArms(a, b) {
  return b.totals.passed - a.totals.passed
    || b.totals.strict - a.totals.strict
    || a.totals.turns - b.totals.turns
    || a.totals.taskMs - b.totals.taskMs
    || a.totals.cacheMissTok - b.totals.cacheMissTok
    || a.name.localeCompare(b.name);
}

function armCard(arm) {
  const t = arm.totals;
  return `<article class="card" style="--arm:${arm.color}"><div class="arm">${escapeHtml(arm.name)} · ${escapeHtml(modelLabel(arm.model))}</div><div class="score">${t.passed}/${t.tasks} <small>hidden contracts</small></div><div class="stats"><div class="stat"><span>Strict</span><b>${t.strict}/${t.tasks}</b></div><div class="stat"><span>Elapsed</span><b>${formatDuration(t.taskMs)}</b></div><div class="stat"><span>Turns</span><b>${t.turns}</b></div><div class="stat"><span>Requests</span><b>${t.requests}</b></div><div class="stat"><span>Input</span><b>${formatCompact(t.inputTok)}</b></div><div class="stat"><span>Cache miss</span><b>${formatCompact(t.cacheMissTok)}</b></div><div class="stat"><span>Output</span><b>${formatCompact(t.outputTok)}</b></div><div class="stat"><span>Reasoning</span><b>${formatCompact(t.reasoningTok)}</b></div></div></article>`;
}

function modelLabel(model = {}) {
  return model.name ? `${model.name}${model.effort ? ` · ${model.effort}` : ""}` : model.runtime;
}

function metricBar(arm, ratio, label) {
  return `<div class="bar-row"><span class="bar-label" style="color:${arm.color}">${escapeHtml(arm.name)}</span><div class="track"><div class="fill" style="--width:${Math.max(2, ratio * 100).toFixed(1)}%;--color:${arm.color}"></div></div><span class="bar-value">${escapeHtml(label)}</span></div>`;
}

function fixtureRow(fixture, arms, manifest, evidenceRoot) {
  return `<tr><td>${escapeHtml(fixture)}</td>${arms.map((arm) => {
    const metric = arm.totals.fixtures[fixture];
    const row = runRows(manifest, arm.name).find((item) => item.name === fixture);
    if (!metric || !row) return "<td>—</td><td>—</td>";
    const result = `${row.status} · ${formatDuration(metric.taskMs)}`;
    return `<td>${row.artifactPath ? `<a href="${escapeAttr(evidenceRoot + row.artifactPath)}">${escapeHtml(result)}</a>` : escapeHtml(result)}</td><td>${metric.turns}</td>`;
  }).join("")}</tr>`;
}

function attachmentHref(row) {
  const artifactDir = path.posix.dirname(String(row.artifactPath ?? ""));
  return path.posix.join(artifactDir, String(row.attachmentIndexPath ?? ""));
}

function attachmentFileHref(row, file) {
  const artifactDir = path.posix.dirname(String(row.artifactPath ?? ""));
  return path.posix.join(artifactDir, String(file ?? ""));
}

function runRows(manifest, armName) {
  return (manifest.schedule ?? []).filter((entry) => entry.arm === armName).flatMap((entry) => entry.runs ?? []);
}

function unique(values) {
  return [...new Set(values)];
}

function dateOnly(value) {
  return typeof value === "string" ? value.slice(0, 10) : "undated";
}

function formatDuration(ms) {
  const seconds = Number(ms) / 1000;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${seconds.toFixed(1)}s`;
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function formatCompact(value) {
  const number = Number(value) || 0;
  return number >= 1_000_000 ? `${(number / 1_000_000).toFixed(2)}m`
    : number >= 1_000 ? `${(number / 1_000).toFixed(1)}k`
      : String(Math.round(number));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
