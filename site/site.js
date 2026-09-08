/* BANTAM FACTORY showcase.
 * Terminal replays, the rooster sprite, and the scroll-driven stage. No dependencies.
 * Demo scripts live in demos.js; sprite frames in rooster.js.
 */
(function () {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('instant');
  const DESKTOP = window.matchMedia('(min-width: 1024px)');
  const R = window.ROOSTER;
  const DEMOS = window.DEMOS || {};
  const CANCEL = Symbol('cancel');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- inline markup for terminal lines ----------
  // [g] gold  [d] dim  [k] bright  [c] comb red  [b] beak cyan  [ok] green  [bad] red
  // [th] think blue  [bo] bold  [ru] rule grey  [u] underline   ...  [/] closes any of them.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TAG = /\[(g|d|k|c|b|ok|bad|th|bo|ru|u)\]|\[\/\]/g;
  const mark = (s) => esc(s).replace(TAG, (m, t) => (t ? `<span class="t-${t}">` : '</span>'));
  const vis = (s) => String(s).replace(TAG, '').length;
  const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - vis(s)));

  // ---------- rooster sprite ----------
  function cells(anim, i) {
    return R.anims[anim].frames[i].map((row) => {
      const out = [];
      for (let x = 0; x < row.length; x += 3) out.push([row[x], row[x + 1], row[x + 2]]);
      return out;
    });
  }
  const col = (h) => (h === 'x' ? null : R.palette[parseInt(h, 16)]);

  // One character cell per sprite cell, painted as two square pixels (top and bottom half),
  // the way a truecolor terminal shows ▀ and ▄. Drawn with CSS so rows meet with no seams.
  function spriteRows(anim, i) {
    return cells(anim, i).map((row) => row.map(([g, f, b]) => {
      const fg = col(f), bg = col(b);
      let top = bg, bot = bg;
      if (g === '1') { top = fg; bot = bg; } else if (g === '2') { top = bg; bot = fg; }
      if (!top && !bot) return '<i class="px"></i>';
      return `<i class="px" style="background:linear-gradient(${top || 'transparent'} 50%,${bot || 'transparent'} 50%)"></i>`;
    }).join(''));
  }

  // Two pixels per cell on a canvas: the hero's big pixel-art bird.
  function drawPixels(canvas, anim, i) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    cells(anim, i).forEach((row, y) => row.forEach(([g, f, b], x) => {
      const fg = col(f), bg = col(b);
      let top = bg, bot = bg;
      if (g === '1') { top = fg; bot = bg; } else if (g === '2') { top = bg; bot = fg; }
      if (top) { ctx.fillStyle = top; ctx.fillRect(x, y * 2, 1, 1); }
      if (bot) { ctx.fillStyle = bot; ctx.fillRect(x, y * 2 + 1, 1, 1); }
    }));
  }

  const SHOWCASE = ['idle', 'idle', 'peck', 'idle', 'flap', 'idle', 'crow', 'idle', 'walk', 'walk'];
  function animate(render, visible) {
    let stop = false, k = 0;
    (async function loop() {
      while (!stop) {
        const name = SHOWCASE[k++ % SHOWCASE.length];
        const a = R.anims[name];
        for (let i = 0; i < a.frames.length && !stop; i++) {
          if (visible()) render(name, i);
          await sleep(1000 / a.fps);
        }
      }
    })();
    return () => { stop = true; };
  }

  // ---------- terminal player ----------
  const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const PROMPT = '<span class="t-c t-bo">bantam</span> <span class="t-g">❯</span> ';
  const SHELL = '<span class="t-d">$</span> ';

  class Term {
    constructor(mount, opts = {}) {
      mount.innerHTML =
        '<div class="term-bar"><span class="term-dot"></span><span class="term-title"></span>' +
        '<button type="button" class="term-pause" hidden aria-pressed="false">Pause</button><button type="button" class="term-replay" hidden>Replay</button></div>' +
        '<div class="term-screen"><div class="term-out"></div></div>';
      this.root = mount;
      this.dot = mount.querySelector('.term-dot');
      this.titleEl = mount.querySelector('.term-title');
      this.replayBtn = mount.querySelector('.term-replay');
      this.pauseBtn = mount.querySelector('.term-pause');
      this.paused = false;
      this.pauseBtn.onclick = () => { this.paused = !this.paused; this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause'; this.pauseBtn.setAttribute('aria-pressed', String(this.paused)); };
      this.screen = mount.querySelector('.term-screen');
      this.out = mount.querySelector('.term-out');
      this.token = 0;
      this.demo = null;
      this.instant = REDUCED || !!opts.instant;
      this.onTitle = opts.onTitle || null;
      this.replayBtn.addEventListener('click', () => { if (this.demo) this.play(this.demo); });
    }
    cancel() { this.token++; }
    check(t) { if (t !== this.token) throw CANCEL; }
    status(s) { this.dot.dataset.state = s; }
    scroll() { this.screen.scrollTop = this.screen.scrollHeight; }
    append(html, cls, indent) {
      const l = document.createElement('div');
      l.className = 'ln' + (cls ? ' ' + cls : '');
      if (indent) { l.style.paddingLeft = indent + 'ch'; l.style.textIndent = '-' + indent + 'ch'; }
      l.innerHTML = html;
      this.out.appendChild(l);
      this.scroll();
      return l;
    }
    async pause(t, ms) {
      if (this.instant || !(ms > 0)) return;
      let remaining = ms;
      while (remaining > 0 || this.paused) {
        this.check(t);
        const started = performance.now(), running = !this.paused;
        await sleep(this.paused ? 50 : Math.min(50, Math.max(1, remaining)));
        if (running && !this.paused) remaining -= performance.now() - started;
      }
      this.check(t);
    }
    async type(t, prefix, text, cps) {
      const l = this.append(prefix + '<span class="typed"></span><span class="cur"></span>', '', prefix === PROMPT ? 9 : 2);
      const span = l.querySelector('.typed');
      if (this.instant) {
        span.textContent = text;
      } else {
        for (const ch of text) {
          span.textContent += ch;
          this.scroll();
          await this.pause(t, 1000 / cps + (ch === ' ' ? 20 : 0));
          this.check(t);
        }
        await this.pause(t, 260);
        this.check(t);
      }
      l.querySelector('.cur').remove();
      this.scroll();
    }
    async lines(t, arr, every) {
      for (const s of arr) {
        const lead = (String(s).match(/^ */) || [''])[0].length;
        this.append(mark(s), '', lead);
        await this.pause(t, every);
      }
    }
    async spinner(t, word, ms) {
      if (this.instant) return;
      const l = this.append('');
      let elapsed = 0, i = 0;
      while (elapsed < ms) {
        l.innerHTML = `<span class="t-c t-bo">bantam</span> <span class="t-b">${SPIN[i++ % SPIN.length]}</span> <span class="t-d">${esc(word)}</span> <span class="t-g">❯</span>`;
        await this.pause(t, 80);
        elapsed += 80;
        this.check(t);
      }
      l.remove();
    }
    // The first screen: sprite on the left, a key/value column on the right, in a rounded frame.
    // Mirrors src/logic/first-screen.js (margins 2/1, gap 2, ╭─╮ corners).
    cols() {
      const probe = document.createElement('span');
      probe.textContent = '0'.repeat(20);
      probe.style.visibility = 'hidden';
      this.out.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 20 || 8;
      probe.remove();
      return Math.floor(this.screen.clientWidth / w) - 4;
    }
    card(anim, lines) {
      const bird = spriteRows(anim, 0);
      const birdW = R.anims[anim].cols;
      const colW = Math.max(0, ...lines.map(vis));
      const inner = 2 + birdW + 2 + colW + 1;
      if (this.cols() < inner + 2) {
        // Too narrow for the framed card (the CLI falls back too): sprite, then the column.
        bird.forEach((r) => this.append(r, 'card'));
        lines.forEach((l) => this.append(mark(l)));
        return;
      }
      // The rounded frame is a CSS border so its edges have no seams between rows.
      const box = document.createElement('div');
      box.className = 'card-box';
      box.style.width = inner + 'ch';
      const n = Math.max(bird.length, lines.length);
      for (let i = 0; i < n; i++) {
        const sprite = i < bird.length ? bird[i] : '<i class="px"></i>'.repeat(birdW);
        const l = document.createElement('div');
        l.className = 'ln card';
        l.innerHTML = '  ' + sprite + '  ' + mark(lines[i] || '');
        box.appendChild(l);
      }
      this.out.appendChild(box);
      this.scroll();
    }
    // A fight-card scoreboard: every contender's clock runs; each stops at its recorded finish.
    async race(t, spec) {
      const W = spec.bar || 26;
      const els = spec.rows.map(() => this.append(''));
      const render = (elapsed) => spec.rows.forEach((r, i) => {
        const done = elapsed >= r.finish;
        const e = Math.min(elapsed, r.finish);
        const filled = Math.round(W * e / spec.total);
        const bar = '█'.repeat(filled) + '·'.repeat(W - filled);
        const clock = e.toFixed(1).padStart(6) + 's';
        const tone = done ? (r.pass ? 't-ok' : 't-bad') : 't-g';
        const tail = done ? `<span class="${tone}">${esc(r.result)}</span>` : '<span class="t-d">working…</span>';
        els[i].innerHTML = mark(`[k]${padEnd(r.label, spec.labelW || 16)}[/]`) +
          `<span class="${tone}">${bar}</span> ` + mark(`[k]${clock}[/]  `) + tail;
      });
      if (this.instant) { render(spec.total); return; }
      let elapsed = 0;
      for (;;) {
        render(elapsed);
        if (elapsed >= spec.total) break;
        await this.pause(t, 50);
        elapsed = Math.min(spec.total, elapsed + 50 / spec.ms * spec.total);
        this.check(t);
      }
    }
    async play(demo) {
      this.cancel();
      const t = this.token;
      this.demo = demo;
      this.out.innerHTML = '';
      this.titleEl.textContent = demo.title || '';
      if (this.onTitle) this.onTitle(demo);
      this.status('running');
      this.replayBtn.hidden = true;
      this.paused = false;
      this.pauseBtn.textContent = 'Pause';
      this.pauseBtn.setAttribute('aria-pressed', 'false');
      this.pauseBtn.hidden = this.instant;
      try {
        for (const step of demo.steps) {
          if (step.cmd !== undefined) await this.type(t, SHELL, step.cmd, 36);
          else if (step.prompt !== undefined) await this.type(t, PROMPT, step.prompt, 46);
          else if (step.working) await this.spinner(t, step.working, step.ms || 900);
          else if (step.out) await this.lines(t, step.out, step.every === undefined ? 45 : step.every);
          else if (step.card) this.card(step.card.anim || 'idle', step.card.lines);
          else if (step.race) await this.race(t, step.race);
          else if (step.status) this.status(step.status);
          else if (step.idle) this.append(PROMPT + '<span class="cur"></span>', '', 9);
          if (step.wait) await this.pause(t, step.wait);
        }
        if (demo.end) this.status(demo.end);
        this.replayBtn.hidden = false;
        this.pauseBtn.hidden = true;
      } catch (e) {
        if (e !== CANCEL) throw e;
      }
    }
  }

  // ---------- page ----------
  function init() {
    // Hero: the big pixel bird.
    for (const heroCanvas of [document.getElementById('headerRooster'), document.getElementById('heroRooster')]) {
      if (!heroCanvas || !R) continue;
      let seen = true;
      new IntersectionObserver(([e]) => { seen = e.isIntersecting; }).observe(heroCanvas);
      drawPixels(heroCanvas, 'idle', 0);
      if (!REDUCED) animate((a, i) => drawPixels(heroCanvas, a, i), () => seen);
    }

    // Stage: one sticky terminal, swapped as the stories scroll past.
    const stories = [...document.querySelectorAll('.story')];
    const stageMount = document.getElementById('stageTerm');
    const stageCap = document.getElementById('stageCap');
    const stage = stageMount ? new Term(stageMount, { onTitle: (d) => { if (stageCap) stageCap.innerHTML = d.caption || ''; } }) : null;
    let active = -1, stageSeen = false;

    function load(term, demo) {
      if (!term || !demo) return;
      term.root.classList.add('is-swapping');
      setTimeout(() => { term.play(demo); term.root.classList.remove('is-swapping'); }, REDUCED ? 0 : 160);
    }
    function setActive(i) {
      if (i === active) return;
      active = i;
      stories.forEach((s, k) => s.classList.toggle('is-active', k === i));
      if (stageSeen && DESKTOP.matches) load(stage, DEMOS[stories[i].dataset.demo]);
    }
    function pick() {
      if (!DESKTOP.matches || !stories.length) return;
      const y = window.innerHeight * 0.5;
      let idx = 0;
      stories.forEach((s, i) => { if (s.getBoundingClientRect().top <= y) idx = i; });
      setActive(idx);
    }
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; pick(); });
    }, { passive: true });
    window.addEventListener('resize', pick);
    if (stageMount) {
      new IntersectionObserver(([e]) => {
        if (!e.isIntersecting || stageSeen) return;
        stageSeen = true;
        if (active < 0) setActive(0); else load(stage, DEMOS[stories[active].dataset.demo]);
      }, { threshold: 0.3 }).observe(stageMount);
    }
    pick();
    if (active < 0 && stories.length) { active = 0; stories[0].classList.add('is-active'); }

    // Under 1024px every story carries its own terminal; it plays once when it comes into view.
    stories.forEach((s) => {
      const mount = s.querySelector('[data-inline]');
      const demo = DEMOS[s.dataset.demo];
      if (!mount || !demo) return;
      const term = new Term(mount);
      const cap = document.createElement('p');
      cap.className = 'term-cap term-cap--inline';
      cap.innerHTML = demo.caption || '';
      mount.after(cap);
      let played = false;
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !played && !DESKTOP.matches) { played = true; term.play(demo); }
      }, { threshold: 0.25 }).observe(mount);
    });

    // The strut: every animation, in a loop, while it is on screen.
    const strutMount = document.getElementById('strutTerm');
    if (strutMount && R) {
      const term = new Term(strutMount);
      term.titleEl.textContent = 'bantam strut';
      term.append(SHELL + 'bantam strut');
      const spriteEl = term.append('', 'sprite');
      const label = term.append('');
      const render = (a, i) => {
        spriteEl.innerHTML = spriteRows(a, i).join('\n');
        label.innerHTML = mark(`[d]${padEnd(a, 6)} ${String(i + 1).padStart(2)}/${R.anims[a].frames.length} @ ${R.anims[a].fps}fps   Ctrl-C to stop[/]`);
      };
      render('idle', 0);
      let seen = false;
      new IntersectionObserver(([e]) => { seen = e.isIntersecting; }).observe(strutMount);
      if (!REDUCED) animate(render, () => seen);
    }

    // Copy buttons.
    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const src = document.querySelector(btn.dataset.copy);
        const text = src ? src.textContent.trim() + '\n' : '';
        try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
        catch (e) { btn.textContent = 'Select it to copy'; }
        setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
