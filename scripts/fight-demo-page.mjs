export function renderContextDemo() {
  return `<section class="tool-demo wrap" id="try-it" aria-labelledby="demo-title"><div class="section-head"><div><p class="eyebrow">BUILT IN THIS FIGHT. READY TO TRY.</p><h2 id="demo-title">Keep what matters.</h2></div><p>BANTAM FACTORY built this context packer in 58.1 seconds. Change the budget. Edit the notes. See what fits.</p></div><div class="demo-controls"><label for="demo-budget">Context budget <strong id="demo-budget-label">640 bytes</strong></label><input id="demo-budget" type="range" min="100" max="1600" step="10" value="640"><button id="demo-reset" class="button">Reset example</button><a class="button" href="#demo-output">See packet ↓</a></div><p id="demo-feedback" class="demo-feedback" role="status">The tool runs in your browser.</p><div class="demo-grid"><div class="demo-inputs" id="demo-inputs"><p class="demo-placeholder">Loading the tool…</p></div><div class="demo-output" id="demo-output"><div class="demo-output-head"><span class="eyebrow">YOUR CONTEXT PACKET</span><strong id="demo-byte-count">—</strong></div><div class="demo-capacity" aria-hidden="true"><i id="demo-fill"></i></div><pre id="demo-result" tabindex="0" aria-label="Packed context"></pre><div class="demo-output-actions"><button id="demo-copy" class="button" disabled>Copy context</button><a class="button" href="../demo/context-packet.js" download="context-packet.mjs">Download the tool ↓</a></div></div></div><p class="demo-caption">The recorded packing functions run here with browser byte counting. This interface is a demo built around that output; it was not part of the timed task. Your edits stay in this browser. <a href="../demo/package.json">Source & adapter receipts ↗</a></p></section>`;
}

export function contextDemoBrowser() {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('try-it')) return;
  const examples = [
    {id: 'The job', priority: 10, required: true, text: 'Build a small file importer. Ask before copying anything into the workspace. Keep the original file untouched. Show where the imported copy was saved.'},
    {id: 'Project notes', priority: 6, required: false, text: 'This project uses Node.js and has a terminal interface. Put imported files in an imports folder. Keep filenames readable, handle spaces, and avoid replacing an existing file. Add a clear success message.'},
    {id: 'Test checklist', priority: 9, required: false, text: 'Check: a normal file, a filename with spaces, a duplicate filename, a missing source file, and a cancelled import. Cancellation must leave the workspace unchanged.'},
    {id: 'Older discussion', priority: 2, required: false, text: 'We talked about a few possible approaches last week: linking the file, granting folder access, or copying it into the project. The chosen first version is an approved copy. The original discussion also covered icons, colors, keyboard shortcuts, progress text, and several ideas for a later release.'},
  ];
  let sections = structuredClone(examples), worker = null, request = 0, timer = null, packed = '';
  const failure = message => {
    $('demo-feedback').textContent = message;
    $('demo-feedback').classList.add('demo-error');
    $('demo-result').textContent = '';
    $('demo-byte-count').textContent = 'No packet';
    $('demo-fill').style.width = '0%';
    $('demo-copy').disabled = true;
    packed = '';
  };
  function run() {
    clearTimeout(timer);
    $('demo-copy').disabled = true;
    $('demo-copy').textContent = 'Copy context';
    const budget = Number($('demo-budget').value);
    $('demo-budget-label').textContent = `${budget.toLocaleString()} bytes`;
    $('demo-feedback').classList.remove('demo-error');
    if (worker) worker.postMessage({id: ++request, sections, maxBytes: budget});
  }
  function inputs() {
    $('demo-inputs').replaceChildren();
    sections.forEach((section, index) => {
      const box = document.createElement('article'); box.className = 'demo-section'; box.dataset.section = section.id;
      const heading = document.createElement('div'); heading.className = 'demo-section-head';
      const label = document.createElement('label'); label.htmlFor = `demo-text-${index}`; label.textContent = section.id;
      const state = document.createElement('span'); state.className = 'demo-section-state';
      heading.append(label, state);
      const text = document.createElement('textarea'); text.id = label.htmlFor; text.value = section.text; text.maxLength = 1600; text.rows = 3; text.spellcheck = false;
      text.oninput = () => {section.text = text.value; $('demo-copy').disabled = true; clearTimeout(timer); timer = setTimeout(run, 100);};
      const options = document.createElement('div'); options.className = 'demo-section-options';
      const pinLabel = document.createElement('label'), pin = document.createElement('input');
      pin.type = 'checkbox'; pin.checked = section.required; pin.onchange = () => {section.required = pin.checked; run();};
      pinLabel.append(pin, document.createTextNode('Always keep'));
      const priorityLabel = document.createElement('label'), priority = document.createElement('select');
      priorityLabel.append(document.createTextNode('Priority '));
      for (const [value, title] of [[10, 'Highest'], [9, 'High'], [6, 'Normal'], [2, 'Low']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = title; priority.append(option);
      }
      priority.value = String(section.priority); priority.onchange = () => {section.priority = Number(priority.value); run();};
      priorityLabel.append(priority); options.append(pinLabel, priorityLabel);
      box.append(heading, text, options); $('demo-inputs').append(box);
    });
  }
  inputs();
  try {
    worker = new Worker('../demo/worker.mjs', {type: 'module'});
    worker.onmessage = ({data}) => {
      if (data.id !== request) return;
      if (data.error) {
        document.querySelectorAll('.demo-section').forEach(node => {node.dataset.kept = ''; node.querySelector('.demo-section-state').textContent = '';});
        failure(data.error === 'required sections exceed budget' ? 'Your pinned notes need more room. Increase the budget or uncheck “Always keep”.' : data.error);
        return;
      }
      const result = data.result, budget = Number($('demo-budget').value);
      packed = result.text;
      $('demo-result').textContent = result.text || 'The packet is empty.';
      $('demo-byte-count').textContent = `${result.bytes.toLocaleString()} / ${budget.toLocaleString()} bytes`;
      $('demo-fill').style.width = `${100 * result.bytes / budget}%`;
      $('demo-feedback').textContent = `${result.included.length} of ${sections.length} notes kept. ${budget - result.bytes} bytes left. Every selected note stays intact.`;
      $('demo-copy').disabled = !packed;
      document.querySelectorAll('.demo-section').forEach(node => {
        const kept = result.included.includes(node.dataset.section); node.dataset.kept = String(kept);
        node.querySelector('.demo-section-state').textContent = kept ? 'KEPT' : 'LEFT OUT';
      });
    };
    worker.onerror = () => {failure('This browser could not start the interactive demo. You can still download the recorded Node.js tool.'); worker?.terminate(); worker = null;};
    run();
  } catch {failure('The interactive demo needs browser worker support. You can still download the recorded Node.js tool.');}
  $('demo-budget').oninput = run;
  $('demo-reset').onclick = () => {sections = structuredClone(examples); $('demo-budget').value = '640'; inputs(); run();};
  $('demo-copy').onclick = async () => {
    try {await navigator.clipboard.writeText(packed); $('demo-copy').textContent = 'Copied';}
    catch {$('demo-result').focus(); $('demo-feedback').textContent = 'Select the context above to copy it.';}
  };
}
