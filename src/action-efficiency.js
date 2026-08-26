// Action efficiency: track which actions are most/least effective
export class ActionEfficiency {
  constructor() {
    this.actions = {};
    this.turns = [];
  }
  record(actionType, success, duration, context) {
    if (!this.actions[actionType]) this.actions[actionType] = { count: 0, success: 0, totalDuration: 0 };
    this.actions[actionType].count++;
    if (success) this.actions[actionType].success++;
    this.actions[actionType].totalDuration += duration || 0;
    this.turns.push({ action: actionType, success, duration, context, ts: Date.now() });
  }
  distribution() {
    return Object.fromEntries(
      Object.entries(this.actions).map(([k, v]) => [k, {
        count: v.count,
        successRate: +((v.success / v.count) * 100).toFixed(1),
        avgDuration: +(v.totalDuration / v.count).toFixed(0),
      }])
    );
  }
  wastedTurns() {
    return this.turns.filter(t => !t.success).length;
  }
  summary() {
    return {
      distribution: this.distribution(),
      wastedTurns: this.wastedTurns(),
      totalTurns: this.turns.length,
    };
  }
}