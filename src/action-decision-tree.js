// Action decision tree: learn which action sequences lead to success
export class ActionDecisionTree {
  constructor() { this.nodes = new Map(); this.successPaths = []; this.failPaths = []; }
  recordPath(path, success) {
    const key = path.join('→');
    this.nodes.set(key, { path, success, count: (this.nodes.get(key)?.count || 0) + 1 });
    if (success) this.successPaths.push(key); else this.failPaths.push(key);
  }
  bestAction(lastAction) {
    const matches = [...this.nodes.values()].filter(n => n.path[n.path.length-2] === lastAction && n.success);
    if (!matches.length) return null;
    matches.sort((a,b) => b.count - a.count);
    return matches[0].path[matches[0].path.length - 1];
  }
  summary() { return { totalPaths: this.nodes.size, successPaths: this.successPaths.length, failPaths: this.failPaths.length }; }
}