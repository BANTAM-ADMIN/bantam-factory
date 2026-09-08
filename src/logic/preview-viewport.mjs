// Chromium's window-size flag clamps narrow windows to 500px. Use its device
// metrics protocol when the caller requests an exact CSS viewport. The pipe is
// private to this child process; no debugging socket or extra dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function runViewportBrowser({ chromium, args, url, width, height, timeoutMs, interact, screenshot, realtime = false }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-preview-viewport-'));
  const child = spawn(chromium, [...args.filter(a => !a.startsWith('--window-size=') && !a.startsWith('--virtual-time-budget=')),
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, buffer = '', stderr = '', closed = false, timedOut = false;
  const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  const exit = new Promise(resolve => {
    child.on('error', error => { closed = true; fail(error); resolve(); });
    child.on('close', () => { closed = true; fail(new Error('Preview browser closed')); resolve(); });
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
  child.stdio[3].on('error', fail);
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', bytes => {
    buffer += bytes.toString();
    if (buffer.length > 32 * 1024 * 1024) { fail(new Error('Preview protocol response exceeded its limit')); child.kill('SIGKILL'); return; }
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(frame), request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } catch { /* Ignore non-JSON protocol noise; the outer timeout stays authoritative. */ }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed || timedOut) return reject(new Error('Preview browser is unavailable'));
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const timer = setTimeout(() => { timedOut = true; fail(new Error('Viewport preview timed out')); child.kill('SIGKILL'); }, timeoutMs);
  let stdout = '', code = 0;
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false });
    const navigation = await call('Page.navigate', { url });
    if (navigation.errorText) throw new Error(navigation.errorText);
    const evaluate = async expression => {
      const value = await call('Runtime.evaluate', { expression, returnByValue: true });
      if (value.exceptionDetails) throw new Error('Viewport evaluation failed');
      return value.result?.value;
    };
    const ready = interact && !realtime
      ? `JSON.parse(document.getElementById('__bantam_report')?.textContent || '{}').interaction?.completed === true`
      : `document.readyState === 'complete' && !!document.getElementById('__bantam_report')`;
    while (!await evaluate(ready)) await new Promise(resolve => setTimeout(resolve, 50));
    // Let layout/paint settle in ordinary wall time. This is not a framerate
    // verdict; the dedicated realtime pass retains that measurement.
    await new Promise(resolve => setTimeout(resolve, realtime ? 4500 : 200));
    stdout = await evaluate('document.documentElement.outerHTML');
    if (screenshot) {
      const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(screenshot, Buffer.from(data, 'base64'));
    }
  } catch (error) {
    code = timedOut ? 124 : 1;
    stderr += '\n' + String(error.message || error);
  } finally {
    clearTimeout(timer);
    if (!closed) child.kill('SIGKILL');
    await exit;
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return { code, signal: null, timedOut, stdout, stderr };
}
