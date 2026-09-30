// Jev mode's model ids. Each names a System One profile: the options passed to
// decideJevAdaptive. `bantam-jev` is the configuration measured on the Decision
// Index; `bantam-jev-fast` never thinks, so every answer is a structured read
// or an exact gauge (tens of milliseconds).

const FULL = Object.freeze({
  gate: 0.95, thinkBudget: 8192, binaryDebias: true, quantGate: true, temperature: 3,
  thinkStyle: "concise", truncatedThought: "keep-fast", rowThinkLimit: 6,
  toolGauge: true, preferenceGauge: true, stateGauge: true, thinkBlend: 0.75, estimateBlend: 0.5,
});

const FAST = Object.freeze({
  ...FULL,
  // A gate of 0 never thinks; the calculator path also thinks, so it is off.
  gate: 0, quantGate: false, rowThinkLimit: 0,
});

export const JEV_PROFILES = Object.freeze({
  "bantam-jev": { options: FULL, description: "BANTAM System One on DiffusionGemma 26B-A4B: structured reads, exact gauges (code execution, tool schemas, state derivation, preference fit) and gated thinking.", execGauge: true },
  "bantam-jev-fast": { options: FAST, description: "BANTAM System One, fast profile: structured reads and exact gauges only, no thinking. Tens of milliseconds per question.", execGauge: true },
});

// Other names clients may ask for, answered by a BANTAM profile.
export const JEV_ALIASES = Object.freeze({
  "openjev-latest": "bantam-jev",
  "openjev-0.1": "bantam-jev",
  "bantam-jev-latest": "bantam-jev",
});

export const RELEASE_DATE = "2026-09-30";

/** The profile a model id asks for, or null when the id is not served. */
export function resolveProfile(model) {
  const name = JEV_ALIASES[model] ?? model;
  const profile = JEV_PROFILES[name];
  return profile ? { name, ...profile } : null;
}

/** GET /v1/models, in Jev's shape. */
export function modelList() {
  return [
    ...Object.entries(JEV_PROFILES).map(([name, p]) => ({ name, description: p.description, release_date: RELEASE_DATE })),
    ...Object.entries(JEV_ALIASES).map(([name, target]) => ({ name, description: `Alias for ${target}.`, release_date: RELEASE_DATE })),
  ];
}
