// Error handling utilities with meaningful diagnostics
export class ErrorHandler {
  constructor() { this.errors = []; }
  wrap(fn, label) {
    return async (...args) => {
      try { const r = await fn(...args); return { ok: true, data: r }; }
      catch (e) {
        const err = { label, message: e.message, ts: Date.now() };
        this.errors.push(err);
        return { ok: false, error: err };
      }
    };
  }
  summary() { return { total: this.errors.length, errors: this.errors.slice(-10) }; }
}