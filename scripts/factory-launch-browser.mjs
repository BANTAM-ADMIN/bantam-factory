// Local publication image capture. Owns its browser, process group and profile;
// never connects to a user browser or accepts an HTTP navigation target.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function captureLaunchImage({browser, file, output, width = 1200, height = 630, scrollY = 0}) {
  if (!path.isAbsolute(browser ?? '') || !path.isAbsolute(file ?? '') || !path.isAbsolute(output ?? ''))
    throw Error('browser, local file and fresh output must be absolute paths');
  if (!/\.(?:svg|html?)$/i.test(file) || !/\.png$/i.test(output) || fs.existsSync(output))
    throw Error('capture requires a local SVG/HTML file and a fresh PNG output');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw Error('capture input must be a bounded regular local file');
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 4096))
    throw Error('capture dimensions must be integers from 1 to 4096');
  if (!Number.isFinite(scrollY) || scrollY < 0 || scrollY > 100000)
    throw Error('capture scrollY must be between 0 and 100000');
  if (process.platform === 'win32') throw Error('isolated browser process-group cleanup requires POSIX');

  // Snap Chromium cannot access the host's ordinary /tmp. This fresh profile
  // is still isolated; no existing browser profile or credentials are loaded.
  const profile = fs.mkdtempSync(path.join(os.homedir(), 'bantam-launch-capture-'));
  let child, settled = false, next = 0, buffer = '', stderr = '', timer;
  const pending = new Map();
  const fail = error => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const stop = error => { fail(error); rejectDeadline(error); };
  const groupSignal = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, {resolve, reject});
    child.stdio[3].write(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}) + '\0', error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  try {
    child = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`, '--remote-debugging-pipe'],
    {detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { settled = true; stop(error); });
    child.on('exit', () => { settled = true; stop(Error('capture browser exited: ' + stderr)); });
    child.stdio[3].on('error', stop);
    child.stdio[4].on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) return stop(Error('capture browser response exceeded limit'));
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const text = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!text) continue;
        let message;
        try { message = JSON.parse(text); } catch { stop(Error('invalid browser protocol response')); return; }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.error) entry.reject(Error(JSON.stringify(message.error))); else entry.resolve(message.result);
      }
    });
    timer = setTimeout(() => stop(Error('capture browser exceeded 17-second deadline')), 17000);
    const capture = async () => {
      const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
      const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
      const tab = (method, params) => call(method, params, sessionId);
      await tab('Page.enable');
      await tab('Runtime.enable');
      await tab('Network.enable');
      await tab('Network.setBlockedURLs', {urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*']});
      await tab('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false,
        screenWidth: width, screenHeight: height});
      await tab('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
      const navigated = await tab('Page.navigate', {url: pathToFileURL(file).href});
      if (navigated.errorText) throw Error('local capture navigation failed: ' + navigated.errorText);
      // Wait for the actual local document, not the preceding about:blank.
      for (;;) {
        const {result} = await tab('Runtime.evaluate', {expression:
          `location.href === ${JSON.stringify(pathToFileURL(file).href)} && document.readyState === 'complete'`, returnByValue: true});
        if (result.value === true) break;
        await delay(20);
      }
      const loaded = await tab('Runtime.evaluate', {expression:
        '(async()=>{await document.fonts?.ready;await Promise.all([...document.images??[]].map(i=>i.decode?.().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {width:innerWidth,height:innerHeight};})()',
      awaitPromise: true, returnByValue: true});
      if (loaded.exceptionDetails || loaded.result.value?.width !== width || loaded.result.value?.height !== height)
        throw Error('browser viewport did not match requested capture dimensions');
      const position = await tab('Runtime.evaluate', {expression:
        `(async()=>{scrollTo({top:${scrollY},behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {x:scrollX,y:scrollY};})()`,
      awaitPromise: true, returnByValue: true});
      if (position.exceptionDetails || !Number.isFinite(position.result.value?.y))
        throw Error('capture scroll position could not be measured');
      const {data} = await tab('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: {x: position.result.value.x, y: position.result.value.y, width, height, scale: 1}});
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG)
          || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height)
        throw Error('browser returned an incorrectly sized PNG');
      fs.writeFileSync(output, bytes, {flag: 'wx'});
      return {output, width, height, bytes: bytes.length};
    };
    return await Promise.race([capture(), deadline]);
  } finally {
    clearTimeout(timer);
    // Signal the entire group even if the launcher already exited: Chromium
    // descendants can otherwise retain the fresh profile and debugging pipes.
    fail(Error('capture browser closing'));
    if (child?.pid) {
      groupSignal('SIGTERM');
      await delay(200);
      groupSignal('SIGKILL');
      for (let i = 0; !settled && i < 50; i++) await delay(20);
    }
    if (!child?.pid || settled) fs.rmSync(profile, {recursive: true, force: true});
    else throw Error('capture browser did not settle; isolated profile retained at ' + profile);
  }
}
