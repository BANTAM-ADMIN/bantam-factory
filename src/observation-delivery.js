// Tool-selected evidence pages and explicitly requested source ranges are
// complete observations. The lab's full-context option also preserves shell
// and visual observations: losing their middle caused repeated diagnostics.
// Context pressure may evict whole older turns instead of cutting their bytes.
export function fullObservation(action, fullReadContext = false) {
  return action?.a === "rea_tool" || action?.a === "rea_tools" || Boolean(fullReadContext && action);
}
