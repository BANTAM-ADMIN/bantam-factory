import fs from 'node:fs';
import path from 'node:path';

export function timingKey(config, width, height, variant = 1) {
  const boundValue = name => {
    const b = config.bindings[name];
    return b ? config.workflow[b[0]].inputs[b[1]] : null;
  };
  return JSON.stringify([config.url, config.workflowHash, width ?? boundValue('width'), height ?? boundValue('height'), variant === 1 ? 'first' : 'subsequent']);
}

function timingFile(workspace) { return path.join(workspace, '.bantam', 'comfyui-timings.json'); }
function readTimings(workspace) {
  try {
    const records = JSON.parse(fs.readFileSync(timingFile(workspace), 'utf8'));
    return Array.isArray(records) ? records.filter(r => typeof r.key === 'string' && Number.isFinite(r.elapsedMs) && r.elapsedMs > 0) : [];
  } catch { return []; }
}
export function imageTimingEstimate(workspace, key) {
  const samples = readTimings(workspace).filter(r => r.key === key).slice(-10).map(r => r.elapsedMs).sort((a, b) => a - b);
  if (!samples.length) return null;
  const middle = Math.floor(samples.length / 2);
  return { expectedMs: samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2,
    samples: samples.length, longestMs: samples.at(-1) };
}
export function saveImageTiming(workspace, key, elapsedMs) {
  const file = timingFile(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [...readTimings(workspace), { key, elapsedMs, at: new Date().toISOString() }].slice(-100);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2));
  fs.renameSync(temp, file);
}

const duration = ms => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.max(1, Math.round(ms / 1000))}s`;

export class ImageProgress {
  constructor({ estimate = null, now = Date.now, stallWarningMs = 180_000 } = {}) {
    this.now = now; this.start = now(); this.lastChange = this.start;
    this.estimate = estimate; this.stallWarningMs = stallWarningMs;
    this.node = null; this.step = null; this.warnings = new Set(); this.hasLiveEvents = false;
  }
  update(event) {
    const data = event.data || {};
    const previous = JSON.stringify([this.node, this.step?.value, this.step?.max]);
    if (event.type === 'executing' && data.node != null) {
      const node = String(data.node);
      if (node !== this.node) { this.node = node; this.step = null; }
    }
    if (event.type === 'progress' && Number.isFinite(data.value) && Number.isFinite(data.max) && data.max > 0) {
      const node = String(data.node ?? this.node ?? '');
      const restarted = node !== this.node || !this.step || data.value < this.step.value || data.max !== this.step.max;
      this.node = node;
      this.step = { value: data.value, max: data.max, firstAt: restarted ? this.now() : this.step.firstAt,
        firstValue: restarted ? data.value : this.step.firstValue };
    }
    if (['executing', 'progress', 'execution_start', 'execution_cached'].includes(event.type)) this.hasLiveEvents = true;
    if (previous !== JSON.stringify([this.node, this.step?.value, this.step?.max]) || event.type === 'execution_start') this.lastChange = this.now();
  }
  snapshot(workflow) {
    const elapsedMs = this.now() - this.start;
    const stage = this.node ? (workflow[this.node]?._meta?.title || workflow[this.node]?.class_type || `node ${this.node}`) : 'loading / waiting';
    const details = [`${stage}`, `${duration(elapsedMs)} elapsed`];
    let stageRemainingMs = null;
    if (this.step) {
      details.push(`${this.step.value}/${this.step.max} steps`);
      const completed = this.step.value - this.step.firstValue;
      if (completed > 0 && this.step.value < this.step.max) {
        stageRemainingMs = (this.now() - this.step.firstAt) / completed * (this.step.max - this.step.value);
        details.push(`~${duration(stageRemainingMs)} left in this stage`);
      }
    }
    const estimatedRemainingMs = this.estimate ? Math.max(0, this.estimate.expectedMs - elapsedMs) : null;
    if (this.estimate) details.push(estimatedRemainingMs > 0
      ? `~${duration(estimatedRemainingMs)} remaining from ${this.estimate.samples} previous run(s)`
      : `past the ${duration(this.estimate.expectedMs)} previous-run estimate`);
    else details.push('learning timing from this run');
    const warnings = [];
    if (this.estimate && elapsedMs > Math.max(this.estimate.expectedMs * 2, this.estimate.longestMs + 60_000) && !this.warnings.has('slow')) {
      this.warnings.add('slow');
      warnings.push('Image generation is unusually slow compared with previous runs. Review progress or use :image cancel.');
    }
    if (this.now() - this.lastChange > this.stallWarningMs && !this.warnings.has('silent')) {
      this.warnings.add('silent');
      warnings.push(`No ${this.hasLiveEvents ? 'new' : 'live'} progress for ${duration(this.now() - this.lastChange)}. ComfyUI may be loading a model or stalled; completion is still being checked. Use :image cancel to stop.`);
    }
    return { message: details.join(' · '), elapsedMs, stage, step: this.step ? { value: this.step.value, max: this.step.max } : null,
      estimatedRemainingMs, stageRemainingMs, warnings };
  }
}
