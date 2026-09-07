import assert from "node:assert/strict";
import os from "node:os";
import fs from 'node:fs';
import path from 'node:path';
import test from "node:test";
import { buildDockerArgs,discoverCodexInstallation } from "../scripts/astra-container-cli.mjs";

const base = {
  args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-6-astra", "task"],
  workspace: "/tmp/astra-test/project", cidfile: "/tmp/astra-test/cids/own.cid", name: "astra-codex-test",
  runtime: { identity:{uid:1000,gid:1000},control:'/tmp/astra-test/runtime',vendor: "/opt/installed-codex", auth: "/home/operator/.codex/auth.json",
    certificates: "/etc/ssl/certs/ca-certificates.crt", npm: "/usr/lib/node_modules/npm", tools: ["/usr/bin/node", "/usr/bin/git"], libraries: [] },
};
function values(args, flag) { return args.flatMap((value, index) => value === flag ? [args[index + 1]] : []); }

test("native Codex bypass remains inside a restricted Docker command with only its project bind writable", () => {
  const args = buildDockerArgs(base);
  assert.equal(args[0], "run");
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(values(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(values(args, "--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(values(args, "--user"), ["1000:1000"]);
  const mounts = values(args, "--mount");
  assert.deepEqual(mounts.filter((mount) => !mount.endsWith(",readonly")), [
    "type=bind,src=/tmp/astra-test/project,dst=/tmp/astra-test/project",
  ]);
  assert.ok(mounts.includes("type=bind,src=/home/operator/.codex/auth.json,dst=/home/ubuntu/.codex/auth.json,readonly"));
  assert.ok(!mounts.some((mount) => mount.includes("docker.sock") || /src=\/home\/operator,/.test(mount)));
  assert.ok(args.indexOf("ubuntu:24.04") < args.indexOf("--dangerously-bypass-approvals-and-sandbox"));
});

test("app-server uses stdio and makes even the candidate project readonly", () => {
  const args = buildDockerArgs({ ...base, args: ["app-server", "--listen", "stdio://"] });
  assert.ok(values(args, "--mount").every((mount) => mount.endsWith(",readonly")));
  assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
  assert.throws(() => buildDockerArgs({ ...base, args: ["app-server", "--listen", "ws://0.0.0.0:8080"] }), /stdio/);
});

test("clean container homes are ephemeral mounts, not mutations of host HOME or CODEX_HOME", () => {
  const args = buildDockerArgs(base);
  assert.ok(values(args, "--tmpfs").some((mount) => mount.startsWith("/home/ubuntu:")));
  assert.ok(values(args, "--tmpfs").some((mount) => mount.startsWith("/home/ubuntu/.codex:")));
  assert.ok(values(args, "--env").every((value) => !/^(?:HOME|CODEX_HOME|OPENAI_API_KEY|BANTAM_API_KEY)=/.test(value)));
  assert.ok(!args.includes("--env-file"));
});

test("every invocation gets an exact CID receipt and an inner bounded deadline", () => {
  const args = buildDockerArgs({ ...base, timeoutSeconds: 120 });
  assert.deepEqual(values(args, "--cidfile"), [base.cidfile]);
  assert.deepEqual(values(args, "--name"), [base.name]);
  assert.ok(args.includes("/usr/bin/timeout"));
  assert.ok(args.includes("120s"));
  assert.ok(args.includes("--kill-after=5s"));
  for (const timeoutSeconds of [0, 1801, NaN, 1.5]) assert.throws(() => buildDockerArgs({ ...base, timeoutSeconds }), /timeout/);
});

test("the local runtime probe has no network and starts no model request", () => {
  const args = buildDockerArgs({ ...base, args: ["--probe"], probe: true });
  assert.deepEqual(values(args, "--network"), ["none"]);
  assert.equal(args.at(-2), "-e");
  assert.ok(args.at(-1).includes("authReadonly"));
  assert.ok(!args.includes("gpt-6-astra"));
});

test("unsafe workspace roots, injected mount separators, arbitrary subcommands, and names fail closed", () => {
  for (const workspace of ["/", os.homedir(), "relative", "/tmp/project,readonly", "/tmp/project:other"]) {
    assert.throws(() => buildDockerArgs({ ...base, workspace }));
  }
  assert.throws(() => buildDockerArgs({ ...base, cidfile: "relative" }), /absolute path/);
  assert.throws(() => buildDockerArgs({ ...base, name: "unowned-container" }), /container name/);
  assert.throws(() => buildDockerArgs({ ...base, args: ["login"] }), /only native exec/);
});

test("optional native session evidence is isolated from the candidate and never includes the auth directory", () => {
  const args = buildDockerArgs({ ...base, sessionDirectory: '/tmp/astra-test/native-sessions' });
  assert.ok(values(args,'--mount').includes('type=bind,src=/tmp/astra-test/native-sessions,dst=/home/ubuntu/.codex/sessions'));
  assert.ok(!values(args,'--mount').some(m=>m.includes('dst=/home/ubuntu/.codex,')));
  for (const sessionDirectory of ['/',os.homedir(),base.workspace,base.workspace+'/logs','/tmp/astra-test']) {
    assert.throws(()=>buildDockerArgs({...base,sessionDirectory}),/separate/);
  }
});

test('non-default non-root identity and discovered tools are mounted without host-home mutation',()=>{
 const args=buildDockerArgs({...base,runtime:{...base.runtime,identity:{uid:2042,gid:3077},vendor:null,binary:'/custom/bin/codex',
  toolMounts:[{source:'/custom/node',target:'/usr/bin/node'},{source:'/custom/git',target:'/usr/bin/git'}],gitCore:'/custom/git-core'}});
 assert.deepEqual(values(args,'--user'),['2042:3077']);
 assert.ok(values(args,'--tmpfs').some(s=>s.includes('uid=2042,gid=3077')));
 assert.ok(values(args,'--mount').includes('type=bind,src=/tmp/astra-test/runtime/passwd,dst=/etc/passwd,readonly'));
 assert.ok(values(args,'--mount').includes('type=bind,src=/custom/bin/codex,dst=/opt/codex/bin/codex,readonly'));
 assert.ok(values(args,'--mount').includes('type=bind,src=/custom/node,dst=/usr/bin/node,readonly'));
 assert.ok(values(args,'--env').includes('GIT_EXEC_PATH=/opt/git-core'));
 assert.throws(()=>buildDockerArgs({...base,runtime:{...base.runtime,identity:{uid:0,gid:0}}}),/non-root/);
});

test('installed binary discovery accepts standalone ELF or resolves npm native bundle, without running it',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-codex-layout-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'codex'),header=Buffer.alloc(64);Buffer.from([127,69,76,70,2,1]).copy(header);header.writeUInt16LE(62,18);
 fs.writeFileSync(binary,header,{mode:0o700});
 const standalone=discoverCodexInstallation(binary,{resolvePackage:()=>{throw Error('must not resolve npm for ELF');}});
 assert.equal(standalone.binary,binary);assert.equal(standalone.vendor,null);assert.equal(standalone.packaging,'standalone-elf');
 header.writeUInt16LE(183,18);fs.writeFileSync(binary,header);
 assert.throws(()=>discoverCodexInstallation(binary),/Linux x64/);
 fs.writeFileSync(binary,'#!/usr/bin/env node\nthrow Error("must not execute");\n');
 const packageFile=path.join(root,'package.json'),native=path.join(root,'vendor/x86_64-unknown-linux-musl/bin/codex');
 fs.mkdirSync(path.dirname(native),{recursive:true});fs.writeFileSync(native,header,{mode:0o700});
 const npm=discoverCodexInstallation(binary,{resolvePackage:()=>packageFile});
 assert.equal(npm.binary,native);assert.equal(npm.packaging,'npm-linux-x64');
 assert.throws(()=>discoverCodexInstallation(binary,{resolvePackage:()=>{throw Error('unknown layout');}}),/nothing was installed/);
});
