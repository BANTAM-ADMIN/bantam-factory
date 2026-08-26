// Campaign planning for a plant with one machine and several tools.
//
// The shadow scheduler models finite worker lanes but assumes the workers are
// simultaneously available. On this hardware they are not: one GPU holds one
// model, and putting a different one on it costs a changeover. That makes worker
// selection a *setup* problem, not just a routing problem, and it is the oldest
// problem in manufacturing — you do not retool the press between every part, you
// run a campaign.
//
// The workers are genuinely different tools rather than better and worse ones:
//
//   diffusiongemma  monster throughput on bulk semantic inspection; its die does
//                   not bind (D18), so it needs a fixture and a gauge
//   qwen-27b        grammar and JSON dies bind, so a station can rely on the die
//                   instead of a fixture
//   orion-26b-a4b   concurrency — one large context divided into several worker
//                   lanes, so several stations can run at once
//
// Horses for courses. What this module adds is the arithmetic that makes that
// phrase executable: given pending operations and what each requires, how few
// changeovers can the work be done in, and what does the naive order cost?
//
// AUTHORITY: none. It plans; it does not start, stop, or swap a server. The
// output is a proposal for an operator, and it says what it would cost rather
// than doing it.

import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";

const KIND = "bantam.factory-campaign-plan";

export function defineWorkerPool(workers) {
  const pool = [...workers].map((worker) => {
    requireKeys(worker, ["id", "capabilities", "changeoverSeconds"], "worker");
    return Object.freeze({
      id: requireText(worker.id, "worker id"),
      capabilities: Object.freeze([...new Set(worker.capabilities)].sort()),
      changeoverSeconds: requireNonNegative(worker.changeoverSeconds, "changeoverSeconds"),
      // Workers sharing an exclusive resource cannot be resident at once. Two
      // workers on different resources are not a changeover at all.
      resource: typeof worker.resource === "string" ? worker.resource : "gpu",
      notes: typeof worker.notes === "string" ? worker.notes : "",
    });
  });
  const seen = new Set();
  for (const worker of pool) {
    if (seen.has(worker.id)) throw new Error(`worker pool repeats ${worker.id}`);
    seen.add(worker.id);
  }
  return Object.freeze(pool);
}

// Plan a campaign. `resident` is the worker currently loaded, so the plan can
// start where the plant actually is rather than from an empty machine.
export function planCampaign({ operations, pool, resident = null }) {
  const workers = defineWorkerPool(pool);
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  if (resident !== null && !byId.has(resident)) throw new Error(`resident worker is not in the pool: ${resident}`);

  const unstaffable = [];
  const grouped = new Map();
  for (const operation of operations) {
    requireKeys(operation, ["id", "requires"], "operation");
    const eligible = workers.filter((worker) => operation.requires.every((need) => worker.capabilities.includes(need)));
    if (!eligible.length) {
      // Never silently drop work. An operation nobody can perform is a planning
      // result, not an absence.
      unstaffable.push({ id: operation.id, requires: [...operation.requires], reason: "no installed worker has every required capability" });
      continue;
    }
    // Deterministic: prefer a worker already carrying other work, then the
    // cheapest changeover, then stable id.
    const chosen = eligible
      .map((worker) => ({ worker, load: grouped.get(worker.id)?.length ?? 0 }))
      .sort((left, right) => right.load - left.load
        || left.worker.changeoverSeconds - right.worker.changeoverSeconds
        || left.worker.id.localeCompare(right.worker.id))[0].worker;
    if (!grouped.has(chosen.id)) grouped.set(chosen.id, []);
    grouped.get(chosen.id).push({ id: operation.id, requires: [...operation.requires], estimateSeconds: Number(operation.estimateSeconds ?? 0) });
  }

  // Run the resident worker's campaign first — its changeover is already paid.
  const order = [...grouped.keys()].sort((left, right) => {
    if (left === resident) return -1;
    if (right === resident) return 1;
    return (grouped.get(right).length - grouped.get(left).length) || left.localeCompare(right);
  });

  let changeovers = 0;
  let changeoverSeconds = 0;
  let current = resident;
  const campaigns = order.map((workerId) => {
    const worker = byId.get(workerId);
    const swap = current !== null && current !== workerId && byId.get(current).resource === worker.resource;
    const cold = current === null;
    if (swap || cold) {
      changeovers += 1;
      changeoverSeconds += worker.changeoverSeconds;
    }
    current = workerId;
    const operationsHere = grouped.get(workerId);
    return {
      worker: workerId,
      changeoverRequired: swap || cold,
      changeoverSeconds: swap || cold ? worker.changeoverSeconds : 0,
      operations: operationsHere.map((operation) => operation.id),
      operationCount: operationsHere.length,
      workSeconds: Number(operationsHere.reduce((total, operation) => total + operation.estimateSeconds, 0).toFixed(2)),
      notes: worker.notes,
    };
  });

  // What the same work would cost if operations ran in the order they arrived,
  // swapping whenever the next one needs a different worker. This is the number
  // the campaign is being compared against, and it is computed rather than
  // assumed.
  const naive = naiveChangeovers({ operations, workers, byId, resident, grouped });

  // Opus-2, 02:26Z: this planner was minimising changeovers, and changeovers are
  // 0.76% of this queue's makespan. The real cost of mutual exclusivity is not
  // the seconds to swap — it is that committing the constraint to one worker
  // BLOCKS every station needing another, and nothing here saw that. The GPU is
  // the constraint, so the objective is value per constraint-second, never
  // letting the constraint idle — Theory of Constraints, not setup reduction.
  const totalWork = campaigns.reduce((sum, c) => sum + c.workSeconds, 0);
  let elapsed = 0;
  const withWait = campaigns.map((campaign) => {
    const queueWaitSeconds = Number(elapsed.toFixed(2));
    elapsed += campaign.changeoverSeconds + campaign.workSeconds;
    return Object.freeze({ ...campaign, queueWaitSeconds, blockedWhileOthersRunSeconds: Number((totalWork + changeoverSeconds - campaign.workSeconds).toFixed(2)) });
  });

  const plan = {
    schema: 1,
    kind: KIND,
    authority: "observe-only",
    resident,
    campaigns: withWait,
    unstaffable,
    summary: {
      operations: operations.length - unstaffable.length,
      unstaffable: unstaffable.length,
      campaigns: campaigns.length,
      changeovers,
      changeoverSeconds: Number(changeoverSeconds.toFixed(2)),
      naiveChangeovers: naive.changeovers,
      naiveChangeoverSeconds: Number(naive.seconds.toFixed(2)),
      changeoversAvoided: naive.changeovers - changeovers,
      secondsSaved: Number((naive.seconds - changeoverSeconds).toFixed(2)),
      // The numbers that actually govern this plant.
      workSeconds: Number(totalWork.toFixed(2)),
      makespanSeconds: Number((totalWork + changeoverSeconds).toFixed(2)),
      changeoverShareOfMakespan: Number((changeoverSeconds / Math.max(1, totalWork + changeoverSeconds)).toFixed(4)),
      constraintUtilisation: Number((totalWork / Math.max(1, totalWork + changeoverSeconds)).toFixed(4)),
      // How long the longest-waiting campaign sits behind the constraint. This
      // is 98x the changeover cost on tonight's queue and was invisible before.
      longestQueueWaitSeconds: Number(Math.max(0, ...withWait.map((c) => c.queueWaitSeconds)).toFixed(2)),
    },
  };
  return deepFreeze({ ...plan, ref: `campaign:sha256:${crypto.createHash("sha256").update(canonicalJson(plan)).digest("hex")}` });
}

function naiveChangeovers({ operations, byId, resident, grouped }) {
  const assignment = new Map();
  for (const [workerId, rows] of grouped) for (const row of rows) assignment.set(row.id, workerId);
  let current = resident;
  let changeovers = 0;
  let seconds = 0;
  for (const operation of operations) {
    const workerId = assignment.get(operation.id);
    if (!workerId) continue;
    const worker = byId.get(workerId);
    if (current === null || (current !== workerId && byId.get(current).resource === worker.resource)) {
      changeovers += 1;
      seconds += worker.changeoverSeconds;
    }
    current = workerId;
  }
  return { changeovers, seconds };
}

export function formatCampaignPlan(plan) {
  const lines = [`FACTORY CAMPAIGN PLAN  ${plan.ref}`, `authority: ${plan.authority}   resident: ${plan.resident ?? "none"}`, ""];
  for (const campaign of plan.campaigns) {
    const swap = campaign.changeoverRequired ? `changeover ${campaign.changeoverSeconds}s` : "already resident";
    lines.push(`  ${campaign.worker.padEnd(18)} ${String(campaign.operationCount).padStart(3)} ops  ${String(campaign.workSeconds).padStart(8)}s work  waits ${String(campaign.queueWaitSeconds).padStart(7)}s  (${swap})`);
    lines.push(`      ${campaign.operations.join(", ")}`);
    if (campaign.notes) lines.push(`      ${campaign.notes}`);
  }
  if (plan.unstaffable.length) {
    lines.push("");
    for (const row of plan.unstaffable) lines.push(`  UNSTAFFABLE ${row.id}: requires ${row.requires.join(", ")} — ${row.reason}`);
  }
  const { summary } = plan;
  lines.push("");
  lines.push(`  ${summary.changeovers} changeover(s) at ${summary.changeoverSeconds}s, against ${summary.naiveChangeovers} at ${summary.naiveChangeoverSeconds}s in arrival order`);
  lines.push(`  ${summary.changeoversAvoided} avoided, ${summary.secondsSaved}s saved — ${(summary.changeoverShareOfMakespan * 100).toFixed(2)}% of a ${summary.makespanSeconds}s makespan`);
  lines.push(`  constraint utilisation ${(summary.constraintUtilisation * 100).toFixed(2)}%   longest queue wait ${summary.longestQueueWaitSeconds}s`);
  lines.push("  the constraint is the GPU: schedule for value per constraint-second, not for swap count");
  lines.push("  this plan starts and stops nothing; it is a proposal for an operator");
  return lines.join("\n");
}

function requireKeys(value, keys, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  for (const key of keys) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
