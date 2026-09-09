#!/usr/bin/env node
// Native Codex runs only inside an outer Docker boundary on hosts where its
// inner bubblewrap sandbox cannot start. No host HOME/config is changed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {nonRootIdentity,identityFiles,discoverPeerTools,linkedLibraries} from '../src/linux-peer-runtime.js';
import {verifyCompetitorRegistration} from '../src/competitor-registry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "ubuntu:24.04";

export function discoverCodexInstallation(selected,{resolvePackage=launcher=>createRequire(launcher).resolve('@openai/codex-linux-x64/package.json')}={}){
  const launcher=fs.realpathSync(absolute(selected,'Codex executable'));
  if(!fs.statSync(launcher).isFile())throw Error('Codex executable must be a regular file');
  fs.accessSync(launcher,fs.constants.R_OK|fs.constants.X_OK);
  const header=Buffer.alloc(64),fd=fs.openSync(launcher,'r');
  try{fs.readSync(fd,header,0,header.length,0);}finally{fs.closeSync(fd);}
  if(header.subarray(0,4).equals(Buffer.from([127,69,76,70]))){
    if(header[4]!==2||header[5]!==1||header.readUInt16LE(18)!==62)throw Error('Codex comparison needs a Linux x64 executable');
    return {launcher,binary:launcher,vendor:null,packaging:'standalone-elf'};
  }
  let vendor;
  try{vendor=path.join(path.dirname(resolvePackage(launcher)),'vendor','x86_64-unknown-linux-musl');}
  catch{throw Error('Cannot resolve installed Codex native binary. Use a supported npm installation or standalone Linux x64 binary on PATH; nothing was installed.');}
  const binary=path.join(vendor,'bin','codex');fs.accessSync(binary,fs.constants.R_OK|fs.constants.X_OK);
  return {launcher,binary,vendor,packaging:'npm-linux-x64'};
}
export function discoverRuntime({executable,executableSha256}={}) {
  const selected=executableSha256?verifyCompetitorRegistration({executable,sha256:executableSha256}):executable;
  const installation=discoverCodexInstallation(selected??execFileSync('which',['codex'],{encoding:'utf8',timeout:3000}).trim());
  const tools=discoverPeerTools();
  return {
    ...installation,...tools,identity:nonRootIdentity(),libraries:linkedLibraries([...tools.tools,installation.binary]),
    auth: path.join(os.homedir(), ".codex", "auth.json"),
    certificates: "/etc/ssl/certs/ca-certificates.crt",
  };
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f,:]/.test(value)) {
    throw new Error(`${label} must be an absolute path without mount separators`);
  }
  return path.resolve(value);
}

export function buildDockerArgs({ args, workspace, runtime, cidfile, name, timeoutSeconds = 480, probe = false, sessionDirectory = null, traceDirectory = null }) {
  const {uid,gid}=nonRootIdentity(runtime.identity);
  const root = absolute(workspace, "workspace");
  if (["/", os.homedir(), REPO].includes(root)) throw new Error("use a disposable project workspace, not a home or harness root");
  if (!Array.isArray(args) || (!probe && !["exec", "app-server"].includes(args[0]))) {
    throw new Error("only native exec or app-server stdio is supported");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 1800) throw new Error("timeout must be 0 (no lifetime deadline) or 1..1800 seconds");
  if (!/^astra-codex-[a-z0-9-]+$/.test(name)) throw new Error("invalid container name");
  if (args[0] === "app-server" && JSON.stringify(args) !== JSON.stringify(["app-server", "--listen", "stdio://"])) {
    throw new Error("app-server must use only stdio transport");
  }
  const mount = (source, target, readonly = true) => ["--mount",
    `type=bind,src=${absolute(source, "mount source")},dst=${absolute(target, "mount target")}${readonly ? ",readonly" : ""}`];
  if (sessionDirectory) {
    sessionDirectory = absolute(sessionDirectory, "session directory");
    if (["/", os.homedir(), REPO, root].includes(sessionDirectory)
      || sessionDirectory.startsWith(root + path.sep) || root.startsWith(sessionDirectory + path.sep)) {
      throw new Error("session directory must be separate from the candidate workspace");
    }
  }
  // Opt-in local provider-request evidence survives even an ephemeral Codex
  // thread. Keep it outside the candidate and mount only the trace directory,
  // never the whole Codex home (which also contains credentials).
  if (traceDirectory) {
    traceDirectory = absolute(traceDirectory, "trace directory");
    if (["/", os.homedir(), REPO, root].includes(traceDirectory)
      || path.resolve(runtime.auth).startsWith(traceDirectory + path.sep)
      || traceDirectory.startsWith(root + path.sep) || root.startsWith(traceDirectory + path.sep)) {
      throw new Error("trace directory must be separate from the candidate workspace");
    }
  }
  const containerArgs = [
    "run", "--rm", "--pull", "never", "--init", "--interactive",
    "--name", name, "--cidfile", absolute(cidfile, "cidfile"),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--user", `${uid}:${gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs", `/home/ubuntu:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=700`,
    "--tmpfs", `/home/ubuntu/.codex:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=700`,
    ...mount(path.join(runtime.control,'passwd'),'/etc/passwd'),
    ...mount(path.join(runtime.control,'group'),'/etc/group'),
    ...mount(root, root, args[0] === "app-server"),
    ...(runtime.vendor?mount(runtime.vendor,'/opt/codex'):mount(runtime.binary,'/opt/codex/bin/codex')),
    ...mount(runtime.auth, "/home/ubuntu/.codex/auth.json"),
    ...(sessionDirectory ? mount(sessionDirectory, "/home/ubuntu/.codex/sessions", false) : []),
    ...(traceDirectory ? mount(traceDirectory, "/home/ubuntu/codex-traces", false) : []),
    ...mount(runtime.certificates, "/etc/ssl/certs/ca-certificates.crt"),
    ...(runtime.toolMounts??runtime.tools.map(tool=>({source:tool,target:tool}))).flatMap(tool=>mount(tool.source,tool.target)),
    ...runtime.libraries.flatMap((library) => mount(fs.realpathSync(library), library)),
    ...mount(runtime.gitCore??'/usr/lib/git-core', '/opt/git-core'),
    ...mount("/usr/share/git-core", "/usr/share/git-core"),
    ...mount(runtime.npm, "/opt/npm"),
    "--env", "PATH=/tmp/astra-tools:/opt/codex/codex-path:/opt/codex/bin:/usr/bin:/bin",
    "--env", "LANG=C.UTF-8", "--env", "NO_COLOR=1",
    ...(traceDirectory ? ["--env", "CODEX_ROLLOUT_TRACE_ROOT=/home/ubuntu/codex-traces"] : []),
    '--env','GIT_EXEC_PATH=/opt/git-core',
    "--workdir", root,
    ...(probe ? ["--network", "none"] : []),
    IMAGE,
  ];
  const setup = 'mkdir -p /tmp/astra-tools && ln -s /opt/npm/bin/npm-cli.js /tmp/astra-tools/npm && ln -s /opt/npm/bin/npx-cli.js /tmp/astra-tools/npx && exec "$@"';
  if (probe) {
    const check = `const fs=require('node:fs');const cp=require('node:child_process');
      fs.writeFileSync('container-write-probe.txt','outer-container-write-ok\\n',{flag:'wx'});
      const auth='/home/ubuntu/.codex/auth.json';fs.accessSync(auth,fs.constants.R_OK);
      let readonly=false;try{fs.accessSync(auth,fs.constants.W_OK)}catch{readonly=true}
      if(!readonly)throw Error('auth mount is not readonly');
      const hostConfig=${JSON.stringify(path.join(os.homedir(), '.codex'))};
      if((hostConfig!=='/home/ubuntu/.codex'&&fs.existsSync(hostConfig))||fs.existsSync('/home/ubuntu/.codex/config.toml'))throw Error('unexpected host config');
      cp.execFileSync('git',['init','--quiet']);cp.execFileSync('git',['add','container-write-probe.txt']);
      cp.execFileSync('git',['-c','user.name=Container Probe','-c','user.email=probe@invalid','commit','--quiet','-m','confined probe']);
      const home=require('node:os').homedir();if(home!=='/home/ubuntu')throw Error('unexpected container home');
      console.log(JSON.stringify({node:process.version,codex:cp.execFileSync('/opt/codex/bin/codex',['--version'],{encoding:'utf8'}).trim(),npm:cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),git:cp.execFileSync('git',['--version'],{encoding:'utf8'}).trim(),uid:process.getuid(),gid:process.getgid(),home,authReadonly:readonly,credentialFixture:true,workspaceWrite:true,hostConfigAbsent:true}));`;
    return [...containerArgs, "/bin/sh", "-c", setup, "astra-runtime", '/usr/bin/timeout','--signal=TERM','--kill-after=5s','30s',"/usr/bin/node", "-e", check];
  }
  // A long project can keep one app-server session alive for hours. An explicit
  // zero opts out of the process lifetime deadline; per-request watchdogs and
  // exact-container cleanup still belong to the caller. Timed cards retain the
  // existing default, and the no-inference setup probe remains bounded above.
  const deadline = timeoutSeconds === 0 ? [] : ["/usr/bin/timeout",
    "--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`];
  return [...containerArgs, "/bin/sh", "-c", setup, "astra-runtime", ...deadline,
    "/opt/codex/bin/codex", ...args];
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("this isolated Codex runtime requires Linux x64");
  }
  nonRootIdentity();
  const workspace = fs.realpathSync(process.cwd());
  const probe = args[0] === "--probe";
  const cidDir = process.env.ASTRA_CONTAINER_CID_DIR;
  const explicitCid = process.env.BANTAM_ASTRA_CONTAINER_CIDFILE;
  if (!cidDir && !explicitCid) throw new Error("set a dedicated ASTRA_CONTAINER_CID_DIR so the driver can clean up exact containers");
  if (cidDir) fs.mkdirSync(absolute(cidDir, "CID directory"), { recursive: true, mode: 0o700 });
  const name = `astra-codex-${process.pid}-${crypto.randomUUID()}`;
  const cidfile = explicitCid || path.join(cidDir, `${name}.cid`);
  if (fs.existsSync(cidfile)) throw new Error("refusing to overwrite an existing CID receipt");
  const runtime = discoverRuntime({executable:process.env.ASTRA_CONTAINER_CODEX_EXECUTABLE,executableSha256:process.env.ASTRA_CONTAINER_CODEX_SHA256});
  runtime.control=fs.mkdtempSync(path.join(path.dirname(cidfile),'runtime-'));
  for(const [file,contents]of Object.entries(identityFiles(runtime.identity)))fs.writeFileSync(path.join(runtime.control,file),contents,{flag:'wx',mode:0o600});
  if(probe){
    runtime.auth=path.join(runtime.control,'auth-fixture.json');fs.writeFileSync(runtime.auth,'{}\n',{flag:'wx',mode:0o600});
  }else{
    try{fs.accessSync(runtime.auth,fs.constants.R_OK);}catch{throw Error('The isolated Codex comparison requires an existing readable file-based auth cache. Keyring-only/custom-home accounts need a separate adapter; BANTAM did not log in or export credentials.');}
  }
  for (const file of [runtime.binary, runtime.certificates]) fs.accessSync(file, fs.constants.R_OK);
  const timeoutSeconds = Number(process.env.ASTRA_CONTAINER_TIMEOUT_SECONDS || "480");
  const sessionDirectory = process.env.ASTRA_CONTAINER_SESSION_DIR || null;
  if (sessionDirectory) {
    const stat = fs.lstatSync(absolute(sessionDirectory, "session directory"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(sessionDirectory) !== path.resolve(sessionDirectory)) {
      throw new Error("session directory must be an existing non-symlink directory");
    }
  }
  const traceDirectory = process.env.ASTRA_CONTAINER_TRACE_DIR || null;
  if (traceDirectory) {
    const stat = fs.lstatSync(absolute(traceDirectory, "trace directory"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(traceDirectory) !== path.resolve(traceDirectory)) {
      throw new Error("trace directory must be an existing non-symlink directory");
    }
  }
  const dockerArgs = buildDockerArgs({ args, workspace, runtime, cidfile, name, timeoutSeconds, probe, sessionDirectory, traceDirectory });
  const child = spawn("docker", dockerArgs, { stdio: "inherit" });
  const cleanup = () => {
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 10000 }); } catch { /* --rm may have finished */ }
    let absent=false;
    try{execFileSync('docker',['inspect',name],{stdio:['ignore','pipe','pipe'],timeout:5000});}
    catch(error){absent=/No such (?:object|container)/i.test(String(error.stderr??''));}
    fs.writeFileSync(path.join(runtime.control,'cleanup.json'),JSON.stringify({name,absent})+'\n',{mode:0o600});
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, cleanup);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    return code;
  } finally {
    cleanup();
    for (const signal of signals) process.off(signal, cleanup);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`astra-container-cli: ${error.message}\n`);process.exitCode = 1;
  });
}
