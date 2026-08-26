#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { admitExocortexMutationProduct, auditCodexMutationArticle, compileDispatchedShiftPrompt, compileExocortexMutationKit, compileRepositoryShiftPacket, defineExocortexDispatchPermit, defineExocortexStandardWork, parseCodexCohortRun, RepositoryGovernanceCell, runFactoryVerifier, summarizeCodexMutationArm } from "../src/factory.js";
import { spawnExternalAgent } from "../src/logic/external-agent.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/codex-exocortex-mutation-cohort-v7.json"));
const schemaPath = resolve(option("schema", ".bantam/factory-benchmarks/codex-mutation-answer.schema.json"));
const model = option("model", "gpt-5.6-terra"), effort = option("effort", "medium");
const repetitions = Number(option("repetitions", "1")), timeoutMs = Number(option("timeout-ms", "600000"));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) throw new Error("--repetitions must be from 1 to 4");
if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new Error("--timeout-ms must be at least 10000");

const experimentRoot = await mkdtemp(join(tmpdir(), "bantam-codex-mutation-cohort-"));
const baseRoot = join(experimentRoot, "defective-base"), hiddenGrader = join(experimentRoot, "hidden-grader.mjs");
try {
  const contract = [
    "Fix normalizePort(value) in src/core.js. Edit only src/core.js; never edit tests or governance.json.",
    "Accepted numbers must be finite integers from 1 through 65535.",
    "Accepted strings may have surrounding whitespace but, after trimming, must contain one or more ASCII decimal digits only; leading zeroes are allowed.",
    "Return the integer port. Throw TypeError for unsupported types, blank/malformed strings, signs, exponent notation, suffixes, NaN, Infinity, or fractional numbers. Throw RangeError for an otherwise numeric integer outside 1..65535.",
    "Determine every repository test transitively affected by src/core.js. Do not weaken tests. Finish with JSON only through the supplied answer die.",
    "Do not mutate the workspace and do not call apply_patch or a shell write command. You are the cognitive worker, not the actuator.",
    "Return the complete proposed contents of src/core.js in replacementSource. The harness will independently admit it and a supervisor-dispatched deterministic actuator will perform any permitted write before independent verification.",
  ].join(" ");
  const standardWork = defineExocortexStandardWork({ schema: 1, kind: "bantam.factory-exocortex-standard-work", id: "bounded-port-normalization-repair", version: 1, title: "Bounded port-normalization repair", role: "Read-only cognitive worker producing one exact source product for a fitted actuator.", instructions: [contract, "Use admitted chassis products to select verification; inspect source as necessary to manufacture the replacement product.", "A button is proposed work, not evidence that work ran.", "Report completed only when replacementSource fully satisfies the stated contract."], outputContract: { fields: ["status", "permitId", "targetPath", "replacementSource", "testsRun"], prose: false } });
  const fixture = await buildFixture(baseRoot, hiddenGrader, standardWork);
  const answerSchema = { type: "object", properties: { status: { type: "string", enum: ["completed", "blocked"] }, permitId: { type: "string" }, targetPath: { type: "string" }, replacementSource: { type: "string" }, testsRun: { type: "array", items: { type: "string" } } }, required: ["status", "permitId", "targetPath", "replacementSource", "testsRun"], additionalProperties: false };
  await mkdir(dirname(schemaPath), { recursive: true }); await writeFile(schemaPath, `${JSON.stringify(answerSchema, null, 2)}\n`);

  const dispatchInstruction = `SUPERVISOR DISPATCH: return permitId exactly as ${fixture.permit.permitId} and targetPath exactly as src/core.js. The fitted actuator—not you—holds the one-use execution capability. Release authority remains withheld.`;
  const controlPrompt = `${contract}\n\n${dispatchInstruction}\n\nCONTROL INTAKE: inspect the repository and authoritative governance.json with read-only discovery tools, determine the affected verification yourself, then manufacture the bounded replacement product. The dispatch permit is available at .bantam/dispatch-permit.json.`;
  const mutationKit = compileExocortexMutationKit({ packet: fixture.packet, permit: fixture.permit });
  const treatment = compileDispatchedShiftPrompt({ packet: fixture.packet, standardWork, permit: fixture.permit, material: mutationKit });
  const treatmentPrompt = `${treatment.prompt}\n${dispatchInstruction}\n`;

  const arms = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const schedule = repetition % 2 === 1 ? [["control", controlPrompt], ["exocortex", treatmentPrompt]] : [["exocortex", treatmentPrompt], ["control", controlPrompt]];
    for (const [arm, prompt] of schedule) {
      const workspace = join(experimentRoot, `${String(arms.length + 1).padStart(2, "0")}-${arm}-${repetition}`);
      await cp(baseRoot, workspace, { recursive: true });
      const before = await hashTree(workspace);
      const run = await spawnExternalAgent("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--model", model, "-c", `model_reasoning_effort=\"${effort}\"`, "--sandbox", "workspace-write", "--output-schema", schemaPath, "--json", prompt], { cwd: workspace, timeoutMs });
      const trace = parseCodexCohortRun(run.stdout);
      const cognitiveProduct = admitExocortexMutationProduct({ answer: trace.answer, permit: fixture.permit });
      const actuation = cognitiveProduct.disposition === "admitted-for-actuation"
        ? await runFittedActuator(workspace, fixture.permit, cognitiveProduct.replacementSource, 30_000)
        : { pass: false, status: "contained", code: null, durationMs: 0, detail: cognitiveProduct.reasons.join(", ") };
      const publicVerification = await runFactoryVerifier(workspace, "node --test test/*.test.js", 120_000);
      const hiddenVerification = await runFactoryVerifier(workspace, `node ${hiddenGrader} ${workspace}`, 120_000);
      const after = await hashTree(workspace);
      const audit = auditCodexMutationArticle({ before, after, allowedPaths: ["src/core.js"], publicVerification, hiddenVerification, modelAnswer: trace.answer });
      const article = { arm, repetition, sequence: arms.length + 1, model, effort, prompt: { bytes: Buffer.byteLength(prompt), approximateTokens: Math.ceil(Buffer.byteLength(prompt) / 4), sha256: sha256(prompt), cachePrefixId: arm === "exocortex" ? treatment.prefixId : null, chassisTailId: arm === "exocortex" ? treatment.tailId : null, dispatchPermitId: fixture.permit.permitId }, run: { code: run.code, timedOut: run.timedOut, durationMs: run.durationMs, usage: trace.usage, itemTypes: trace.itemTypes, commands: trace.commands, traceId: trace.traceId, stderrTail: run.stderr.slice(-1200) }, cognitiveProduct, actuation, audit, candidateCore: await readFile(join(workspace, "src", "core.js"), "utf8") };
      arms.push(article);
      console.log(JSON.stringify({ arm, repetition, disposition: audit.disposition, reasons: audit.reasons, durationMs: run.durationMs, usage: trace.usage, commands: trace.commands.length }));
    }
  }
  const control = summarizeCodexMutationArm(arms.filter((row) => row.arm === "control")), exocortex = summarizeCodexMutationArm(arms.filter((row) => row.arm === "exocortex"));
  const reportBody = { schema: "bantam.factory.codex-exocortex-mutation-cohort.v1", completedAt: new Date().toISOString(), question: "Can a proof-bearing exocortex reduce reconstruction work on a real bounded mutation without reducing independently verified yield?", design: { matchedModel: true, matchedEffort: true, matchedExecutionAuthority: true, isolatedWorkspaces: true, crossoverOrder: true, cognitiveWorkerSeparatedFromActuator: true, writableScope: ["src/core.js"], publicAndHiddenVerification: true, testTamperingContained: true, repetitions }, inputs: { model, effort, fixture: fixture.manifest, packet: { packetId: fixture.packet.packetId, products: fixture.packet.products.length, estimatedTokens: fixture.packet.estimatedTokens }, mutationKit: { kitId: mutationKit.kitId, bytes: Buffer.byteLength(JSON.stringify(mutationKit)), affectedTests: mutationKit.routing.affectedTests.length, governedRequirements: mutationKit.routing.governedRequirements.length, proofRefs: mutationKit.proofRefs.length }, dispatchPermit: fixture.permit, cacheLayout: { standardWorkRef: treatment.standardWorkRef, prefixId: treatment.prefixId, tailId: treatment.tailId, metrics: treatment.metrics }, baselineControls: fixture.controls }, arms, aggregate: { control, exocortex }, comparison: compare(control, exocortex), caveats: ["Small synthetic first article; not workforce qualification.", "Same precise function contract and execution permit are disclosed to both arms.", "The cognitive worker emits material; the deterministic actuator alone holds mutation execution authority.", "The permit grants mutation execution but explicitly withholds release authority.", "Hidden verifier tests behavioral edge cases but is not a proof of general correctness.", "Provider cache behavior can vary across service runs."] };
  const report = { ...reportBody, reportId: `codex-exocortex-mutation-cohort:sha256:${sha256(JSON.stringify(reportBody))}` };
  await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: arms.every((row) => row.audit.disposition === "released") ? "released-cohort" : "contained-cohort", aggregate: report.aggregate, comparison: report.comparison, reportPath: outputPath }, null, 2));
} finally {
  await rm(experimentRoot, { recursive: true, force: true });
}

async function buildFixture(root, graderPath, standardWork) {
  await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n");
  const correct = `export function normalizePort(value) {\n  let text;\n  if (typeof value === "number") {\n    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError("port must be an integer");\n    text = String(value);\n  } else if (typeof value === "string") {\n    text = value.trim();\n    if (!/^[0-9]+$/.test(text)) throw new TypeError("port must be decimal digits");\n  } else throw new TypeError("port must be a number or string");\n  const port = Number(text);\n  if (port < 1 || port > 65535) throw new RangeError("port out of range");\n  return port;\n}\n`;
  const defective = `export function normalizePort(value) {\n  const port = Number.parseInt(String(value).trim(), 10);\n  if (!Number.isFinite(port) || port < 0 || port > 65535) throw new RangeError("port out of range");\n  return port;\n}\n`;
  await writeFile(join(root, "src", "core.js"), correct);
  for (let index = 1; index <= 30; index += 1) { const prior = index === 1 ? "core" : `module-${String(index - 1).padStart(2, "0")}`; await writeFile(join(root, "src", `module-${String(index).padStart(2, "0")}.js`), `export { normalizePort } from './${prior}.js';\n`); }
  const targets = [0, 5, 10, 15, 20, 25, 30], cases = [["'80'", 80], ["' 8080 '", 8080], ["65535", 65535], ["'00042'", 42], ["'1'", 1], ["443", 443]];
  for (let i = 0; i < targets.length; i += 1) { const index = targets[i], source = index === 0 ? "core" : `module-${String(index).padStart(2, "0")}`, [input, expected] = cases[i % cases.length]; const extra = i === targets.length - 1 ? "\nassert.throws(() => normalizePort('0'));" : ""; await writeFile(join(root, "test", `${source}.test.js`), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { normalizePort } from '../src/${source}.js';\ntest('${source}', () => { assert.equal(normalizePort(${input}), ${expected});${extra}\n});\n`); }
  await writeFile(graderPath, `import assert from "node:assert/strict"; import { join } from "node:path"; import { pathToFileURL } from "node:url"; const root=process.argv[2]; const {normalizePort}=await import(pathToFileURL(join(root,"src/core.js"))); for(const [v,n] of [["00080",80],[" 65535 ",65535],[1,1],[8080,8080]]) assert.equal(normalizePort(v),n); for(const v of [""," ","12x","1e2","+42","-1",true,null,undefined,{},80.5,NaN,Infinity]) assert.throws(()=>normalizePort(v),TypeError); for(const v of ["0","65536",0,-1,65536]) assert.throws(()=>normalizePort(v),RangeError); console.log("hidden port contract passed");\n`);
  const requirements = [{ requirement: "requirement:port-normalization", component: "src/core.js", test: "test/core.test.js", authority: "authority:network-board", fingerprint: "current" }, { requirement: "requirement:service-port-compatibility", component: "src/module-20.js", test: "test/module-20.test.js", authority: "authority:platform-board", fingerprint: "current" }];
  const cell = new RepositoryGovernanceCell({ root }); let original;
  for (const governance of requirements) original = cell.cycle({ changedPaths: ["src/core.js"], governance });
  const goldPublic = await runFactoryVerifier(root, "node --test test/*.test.js", 120_000), goldHidden = await runFactoryVerifier(root, `node ${graderPath} ${root}`, 120_000);
  await writeFile(join(root, "src", "core.js"), defective);
  const changed = cell.cycle({ changedPaths: ["src/core.js"] });
  const packet = compileRepositoryShiftPacket({ task: "Repair normalizePort under the exact bounded contract in the station standard work.", bus: cell.bus, registry: cell.registry, cell: cell.cell, focus: { paths: ["src/core.js"], requirements: requirements.map((row) => row.requirement) }, limits: { maxProducts: 28, maxDependenciesPerProduct: 6 } });
  const governanceRecord = { schema: 1, kind: "accepted-governance-record", changed: "src/core.js", currentFingerprint: changed.source.fingerprint, supersedes: original.source.fingerprint, requirements: requirements.map(({ fingerprint: _fingerprint, ...row }) => ({ ...row, evidenceValidatedFingerprint: original.source.fingerprint, authorityApprovedFingerprint: original.source.fingerprint })), nextOperationPolicy: { affectedTest: "run-verification", staleEvidence: "refresh-evidence", staleAuthority: "request-approval" } };
  await writeFile(join(root, "governance.json"), `${JSON.stringify(governanceRecord, null, 2)}\n`);
  await mkdir(join(root, ".bantam"), { recursive: true });
  const defectiveHash = sha256(defective);
  const editorPath = join(root, ".bantam", "fitted-edit.mjs");
  const editorSource = `import { createHash } from "node:crypto"; import { readFile, rename, writeFile } from "node:fs/promises"; import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url"; const root=resolve(dirname(fileURLToPath(import.meta.url)),".."); const target=join(root,"src/core.js"), temp=join(root,".bantam","core.replacement.tmp"), permitPath=join(root,".bantam","dispatch-permit.json"); const permit=JSON.parse(await readFile(permitPath,"utf8")); const supplied=process.argv[process.argv.indexOf("--permit-id")+1]; const self=createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"); const allowed=permit.packetId==="${packet.packetId}"&&permit.chassisFingerprint==="${changed.source.fingerprint}"&&permit.standardWorkRef==="${standardWork.ref}"&&permit.operation==="bounded-source-replacement"&&permit.tool?.path===".bantam/fitted-edit.mjs"&&permit.tool?.sha256===self&&permit.scope?.allowedPaths?.length===1&&permit.scope.allowedPaths[0]==="src/core.js"&&permit.authority?.execute==="granted"&&permit.authority?.release==="withheld"&&permit.authority?.uses===1&&supplied===permit.permitId; if(!allowed) throw new Error("fitted editor refused: dispatch permit mismatch"); const current=await readFile(target); const hash=createHash("sha256").update(current).digest("hex"); if(hash!=="${defectiveHash}") throw new Error("fitted editor refused: baseline hash changed"); let source=""; for await(const chunk of process.stdin) source+=chunk; if(!source.trim()||!source.includes("export function normalizePort")) throw new Error("fitted editor refused: replacement product is malformed"); await writeFile(temp,source,{mode:0o600}); await rename(temp,target); console.log("fitted editor executed one permitted replacement; release authority remains withheld");\n`;
  await writeFile(editorPath, editorSource);
  const editorHash = sha256(editorSource);
  const permit = defineExocortexDispatchPermit({ schema: 1, kind: "bantam.factory-exocortex-dispatch-permit", packetId: packet.packetId, chassisFingerprint: changed.source.fingerprint, standardWorkRef: standardWork.ref, articleId: "normalize-port-repair", workerRole: "deterministic-fitted-actuator", operation: "bounded-source-replacement", tool: { id: "fitted-editor", path: ".bantam/fitted-edit.mjs", sha256: editorHash, invocation: "node .bantam/fitted-edit.mjs --permit-id <permit-id>" }, scope: { allowedPaths: ["src/core.js"] }, authority: { execute: "granted", release: "withheld", uses: 1 } });
  await writeFile(join(root, ".bantam", "dispatch-permit.json"), `${JSON.stringify(permit, null, 2)}\n`);
  const defectivePublic = await runFactoryVerifier(root, "node --test test/*.test.js", 120_000), defectiveHidden = await runFactoryVerifier(root, `node ${graderPath} ${root}`, 120_000);
  if (!goldPublic.pass || !goldHidden.pass || defectivePublic.pass || defectiveHidden.pass) throw new Error(`mutation cohort fixture failed gold/defect controls: ${JSON.stringify({ goldPublic, goldHidden, defectivePublic, defectiveHidden })}`);
  const jigDrive = await runFactoryVerifier(root, `node .bantam/fitted-edit.mjs --permit-id ${permit.permitId} <<'BANTAM_SOURCE'\n${correct}BANTAM_SOURCE\n`, 120_000);
  const jigPublic = await runFactoryVerifier(root, "node --test test/*.test.js", 120_000), jigHidden = await runFactoryVerifier(root, `node ${graderPath} ${root}`, 120_000);
  await writeFile(join(root, "src", "core.js"), defective);
  if (!jigDrive.pass || !jigPublic.pass || !jigHidden.pass) throw new Error(`mutation cohort fitted editor failed qualification: ${JSON.stringify({ jigDrive, jigPublic, jigHidden })}`);
  return { packet, permit, controls: { goldPublic, goldHidden, defectivePublic, defectiveHidden, fittedEditor: { drive: jigDrive, publicVerification: jigPublic, hiddenVerification: jigHidden, restoredDefectiveBaseline: sha256(await readFile(join(root, "src", "core.js"))) === defectiveHash } }, manifest: { kind: "bounded-port-normalization-repair", sourceModules: 31, publicTests: targets.length, governedRequirements: requirements.length, allowedPath: "src/core.js", fittedEditor: ".bantam/fitted-edit.mjs", fittedEditorSha256: editorHash, dispatchPermitId: permit.permitId, oldFingerprint: original.source.fingerprint, defectiveFingerprint: changed.source.fingerprint, packetId: packet.packetId } };
}

async function hashTree(root) { const result = {}; for (const file of await files(root)) result[file] = sha256(await readFile(join(root, file))); return result; }
async function files(root) { const output = [], stack = [root]; while (stack.length) { const dir = stack.pop(); for (const entry of await readdir(dir, { withFileTypes: true })) { const absolute = join(dir, entry.name); if (entry.isDirectory()) stack.push(absolute); else if (entry.isFile()) output.push(relative(root, absolute).split("\\").join("/")); } } return output.sort(); }
function compare(control, treatment) { return { yieldDelta: treatment.yield - control.yield, meanDurationRatio: ratio(treatment.durationMs.mean, control.durationMs.mean), meanCommandRatio: ratio(treatment.commands.mean, control.commands.mean), meanInputTokenRatio: ratio(treatment.inputTokens.mean, control.inputTokens.mean), meanUncachedInputTokenRatio: ratio(treatment.uncachedInputTokens.mean, control.uncachedInputTokens.mean), meanOutputTokenRatio: ratio(treatment.outputTokens.mean, control.outputTokens.mean) }; }
function ratio(value, baseline) { return baseline === 0 ? (value === 0 ? 1 : null) : value / baseline; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function runFittedActuator(workspace, permit, source, timeoutMs) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [".bantam/fitted-edit.mjs", "--permit-id", permit.permitId], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (code, status = code === 0 ? "pass" : "fail") => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise({ pass: code === 0, status, code, durationMs: Date.now() - started, detail: `${stdout}${stderr}`.slice(-4000) }); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } finish(null, "timeout"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; finish(null, "error"); }); child.on("close", (code) => finish(code));
    child.stdin.end(source);
  });
}
