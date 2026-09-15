// Pluggable solvers. A solver takes a card and returns a string answer.
// The baseline solver is a fixed heuristic — intentionally simple so the
// bench runs without an LLM. Swap in a model-backed solver to measure it.

export const solvers = {
  // Always returns the known-correct answer. Useful as a sanity check that
  // the bench plumbing works end-to-end.
  oracle: (card) => card.answer,

  // A deliberately weak solver: gets some cards right, others wrong.
  // This gives compare.js something interesting to show.
  baseline: (card) => {
    switch (card.id) {
      case 'c01': return '5050';      // correct
      case 'c02': return '89';        // wrong (off by one Fibonacci)
      case 'c03': return 'yes';       // correct
      case 'c04': return 'man tab';   // correct
      case 'c05': return '7';         // wrong (misses one vowel)
      default: return '';
    }
  },

  // A solver that always fails. Floor of the scale.
  null: () => '',
};
