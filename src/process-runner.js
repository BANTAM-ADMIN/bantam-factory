import { spawn } from "node:child_process";

export function sliceBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let end = 0;
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > maxBytes) break;
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

export function runProcess(file, args, {
  cwd,
  env = process.env,
  timeoutMs = 30000,
  maxBuffer = 10 * 1024 * 1024,
  signal: abortSignal = null,
  onOutput = null,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let bufferExceeded = false;
    let aborted = false;
    let settled = false;
    let timer = null;
    let abortHandler = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortHandler && abortSignal) abortSignal.removeEventListener("abort", abortHandler);
      resolve({
        stdout,
        stderr,
        timedOut,
        bufferExceeded,
        aborted,
        ...result,
      });
    };

    const append = (chunk, which) => {
      const text = chunk.toString("utf8");
      const remaining = maxBuffer - bytes;
      let accepted = "";
      if (remaining > 0) {
        accepted = sliceBytes(text, remaining);
        if (which === "stdout") stdout += accepted;
        else stderr += accepted;
        bytes += Buffer.byteLength(accepted);
      }
      if (accepted && typeof onOutput === "function") {
        try {
          const result = onOutput({ stream: which, text: accepted });
          if (result?.then) result.catch(() => {});
        } catch {
          // Output observers must never interfere with the child process.
        }
      }
      if (!bufferExceeded && bytes >= maxBuffer) {
        bufferExceeded = true;
        killProcessTree(child);
      }
    };

    if (abortSignal?.aborted) {
      aborted = true;
      finish({ code: 1, signal: null });
      return;
    }

    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ code: 1, signal: null, error: e });
    }

    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (e) => finish({ code: 1, signal: null, error: e }));
    child.on("close", (code, signal) => finish({
      code: typeof code === "number" ? code : signal ? 1 : 0,
      signal,
    }));

    if (abortSignal) {
      abortHandler = () => {
        aborted = true;
        killProcessTree(child);
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
      // Close the race between the pre-spawn check and listener registration.
      if (abortSignal.aborted) abortHandler();
    }

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
  });
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
