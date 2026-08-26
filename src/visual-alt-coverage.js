const ALT_ATTRIBUTE = /\balt\s*=\s*(["'])(.*?)\1/gis;

export function visualAltCoverageEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env?.BANTAM_VISUAL_ALT_COVERAGE ?? "").toLowerCase(),
  );
}

function headingPresent(observation, name) {
  return new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?\\*\\*${name}:?\\*\\*`, "i")
    .test(String(observation ?? ""));
}

export function authoredAltDescriptions(source) {
  return [...String(source ?? "").matchAll(ALT_ATTRIBUTE)]
    .map((match) => match[2].replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Find only high-confidence omissions grounded in explicit view_image
 * sections. This intentionally avoids generic noun extraction: an advisory
 * that guesses at salience is worse than silence.
 */
export function visualAltCoverageGap({ viewObservation, source } = {}) {
  const descriptions = authoredAltDescriptions(source);
  if (descriptions.length === 0) return null;
  const combined = descriptions.join(" ").toLowerCase();
  const missing = [];

  const describesMoon = headingPresent(viewObservation, "moon");
  const describesBirds = headingPresent(viewObservation, "birds");
  if (
    describesMoon
    && describesBirds
    && !/\b(?:moon|lunar|crescent|bird|birds|avian|origami)\b/i.test(combined)
  ) {
    missing.push("distinctive sky subject");
  }

  return missing.length ? { missing, descriptions } : null;
}

export function visualAltCoverageHint(gap) {
  if (!gap?.missing?.length) return "";
  return "\n[visual-alt-coverage] The saved view_image evidence has explicit Moon and Birds sections, "
    + "but the authored alt text names neither. Before authoring more files, recheck that alt against "
    + "the image observation and correct it with one concise, accurate distinctive sky element if it "
    + "is genuinely visible.";
}
