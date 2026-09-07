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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "ubuntu:24.04";

export function discoverRuntime() {
  const launcher = fs.realpathSync(execFileSync("which", ["codex"], { encoding: "utf8" }).trim());
  const require = createRequire(launcher);
  const installed = path.dirname(require.resolve("@openai/codex-linux-x64/package.json"));
  const vendor = path.join(installed, "vendor", "x86_64-unknown-linux-musl");
  const tools = ["/usr/bin/node", "/usr/bin/git"];
  const libraries = new Set();
  for (const tool of tools) {
    const output = execFileSync("ldd", [tool], { encoding: "utf8" });
    for (const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)) libraries.add(match[1]);
  }
  return {
    vendor, tools, libraries: [...libraries],
    auth: path.join(os.homedir(), ".codex", "auth.json"),
    certificates: "/etc/ssl/certs/ca-certificates.crt",
    npm: "/usr/lib/node_modules/npm",
  };
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f,:]/.test(value)) {
    throw new Error(`${label} must be an absolute path without mount separators`);
  }
  return path.resolve(value);
}

export function buildDockerArgs({ args, workspace, runtime, cidfile, name, timeoutSeconds = 480, probe = false, sessionDirectory = null }) {
  const root = absolute(workspace, "workspace");
  if (["/", os.homedir(), REPO].includes(root)) throw new Error("use a disposable project workspace, not a home or harness root");
  if (!Array.isArray(args) || (!probe && !["exec", "app-server"].includes(args[0]))) {
    throw new Error("only native exec or app-server stdio is supported");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) throw new Error("timeout must be 1..1800 seconds");
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
  const containerArgs = [
    "run", "--rm", "--pull", "never", "--init", "--interactive",
    "--name", name, "--cidfile", absolute(cidfile, "cidfile"),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--user", "1000:1000",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs", "/home/ubuntu:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700",
    "--tmpfs", "/home/ubuntu/.codex:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700",
    ...mount(root, root, args[0] === "app-server"),
    ...mount(runtime.vendor, "/opt/codex"),
    ...mount(runtime.auth, "/home/ubuntu/.codex/auth.json"),
    ...(sessionDirectory ? mount(sessionDirectory, "/home/ubuntu/.codex/sessions", false) : []),
    ...mount(runtime.certificates, "/etc/ssl/certs/ca-certificates.crt"),
    ...runtime.tools.flatMap((tool) => mount(tool, tool)),
    ...runtime.libraries.flatMap((library) => mount(fs.realpathSync(library), library)),
    ...mount("/usr/lib/git-core", "/usr/lib/git-core"),
    ...mount("/usr/share/git-core", "/usr/share/git-core"),
    ...mount(runtime.npm, "/opt/npm"),
    "--env", "PATH=/tmp/astra-tools:/opt/codex/codex-path:/opt/codex/bin:/usr/bin:/bin",
    "--env", "LANG=C.UTF-8", "--env", "NO_COLOR=1",
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
      console.log(JSON.stringify({node:process.version,codex:cp.execFileSync('/opt/codex/bin/codex',['--version'],{encoding:'utf8'}).trim(),npm:cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),git:cp.execFileSync('git',['--version'],{encoding:'utf8'}).trim(),authReadonly:readonly,workspaceWrite:true,hostConfigAbsent:true}));`;
    return [...containerArgs, "/bin/sh", "-c", setup, "astra-runtime", "/usr/bin/node", "-e", check];
  }
  return [...containerArgs, "/bin/sh", "-c", setup, "astra-runtime", "/usr/bin/timeout",
    "--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`, "/opt/codex/bin/codex", ...args];
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
    throw new Error("this tested Ubuntu runtime requires Linux x64 and host uid/gid 1000");
  }
  const workspace = fs.realpathSync(process.cwd());
  const probe = args[0] === "--probe";
  const cidDir = process.env.ASTRA_CONTAINER_CID_DIR;
  const explicitCid = process.env.BANTAM_ASTRA_CONTAINER_CIDFILE;
  if (!cidDir && !explicitCid) throw new Error("set a dedicated ASTRA_CONTAINER_CID_DIR so the driver can clean up exact containers");
  if (cidDir) fs.mkdirSync(absolute(cidDir, "CID directory"), { recursive: true, mode: 0o700 });
  const name = `astra-codex-${process.pid}-${crypto.randomUUID()}`;
  const cidfile = explicitCid || path.join(cidDir, `${name}.cid`);
  if (fs.existsSync(cidfile)) throw new Error("refusing to overwrite an existing CID receipt");
  const runtime = discoverRuntime();
  for (const file of [runtime.auth, path.join(runtime.vendor, "bin", "codex"), runtime.certificates]) fs.accessSync(file, fs.constants.R_OK);
  const timeoutSeconds = Number(process.env.ASTRA_CONTAINER_TIMEOUT_SECONDS || "480");
  const sessionDirectory = process.env.ASTRA_CONTAINER_SESSION_DIR || null;
  if (sessionDirectory) {
    const stat = fs.lstatSync(absolute(sessionDirectory, "session directory"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(sessionDirectory) !== path.resolve(sessionDirectory)) {
      throw new Error("session directory must be an existing non-symlink directory");
    }
  }
  const dockerArgs = buildDockerArgs({ args, workspace, runtime, cidfile, name, timeoutSeconds, probe, sessionDirectory });
  const child = spawn("docker", dockerArgs, { stdio: "inherit" });
  const cleanup = () => {
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 10000 }); } catch { /* --rm may have finished */ }
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
