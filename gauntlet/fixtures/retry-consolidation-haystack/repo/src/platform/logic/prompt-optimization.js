// Prompt optimization: rule-ablation tracker that measures pass-rate delta per rule
import fs from 'node:fs';
import path from 'node:path';

export class PromptOptimizer {
  constructor() {
    this.rules = [];
    this.results = [];
    this.baselinePassRate = 100;
  }

  addRule(name, description) {
    this.rules.push({ name, description, enabled: true });
  }

  async ablationTest(ruleName, testFn) {
    const rule = this.rules.find(r => r.name === ruleName);
    if (!rule) return { rule: ruleName, delta: 0 };

    rule.enabled = false;
    // A harness failure is NOT a pass rate of zero. Zero is a valid measurement --
    // "disabling this rule broke everything" -- so swallowing the error here makes
    // a crashed test suite look like proof the rule is essential, and would do it
    // for EVERY rule whenever the infrastructure is down. Exactly what happened to
    // the eval summary when Codex ran out of quota and reported 0/1 passed.
    let passRate = null;
    let failure = null;
    try {
      passRate = await testFn();
    } catch (error) {
      failure = String(error?.message ?? error).slice(0, 200);
    }
    if (failure !== null) {
      const unmeasured = { rule: ruleName, passRate: null, delta: null, error: failure };
      this.results.push(unmeasured);
      return unmeasured;
    }
    rule.enabled = true;

    const delta = passRate - this.baselinePassRate;
    this.results.push({ rule: ruleName, passRate, delta });
    return { rule: ruleName, passRate, delta };
  }

  getImpactReport() {
    return this.results.map(r => ({
      rule: r.rule,
      passRate: r.passRate,
      delta: r.delta,
      significant: Math.abs(r.delta) > 5,
    }));
  }

  suggestRemovals(threshold = 5) {
    return this.results.filter(r => Math.abs(r.delta) < threshold).map(r => r.rule);
  }
}

export async function buildPromptOptimizer(ws) {
  const p = path.join(ws, 'src/logic/prompt-optimization.js');
  if (fs.existsSync(p)) return [{ file: p, action: 'exists' }];
  return [{ file: p, action: 'created' }];
}
