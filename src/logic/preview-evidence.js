// Trusted preview evidence retained across agent turns.
//
// A preview is a real execution of the web deliverable. If it is red, `done`
// must not turn that evidence into prose claiming the page was verified. Edits
// after a preview invalidate it and require a fresh render.

export function previewRecheckCommand(preview, { requireInteraction = false } = {}) {
  const command = ['preview', String(preview?.entry ?? '').trim(),
    requireInteraction || preview?.mode === 'interact' ? 'interact' : ''].filter(Boolean);
  const sizes = preview?.views?.map(view => view.viewport) ?? (preview?.viewport ? [preview.viewport] : []);
  if (sizes.length) command.push(`--viewports=${sizes.map(v => `${v.width}x${v.height}`).join(',')}`);
  return command.join(' ');
}

export function unresolvedPreviewObjection(
  latestPreview,
  workspaceGeneration,
  alreadyRejected = 0,
  {
    maxRejections = 2,
    requireInteraction = false,
  } = {},
) {
  if (!latestPreview || alreadyRejected >= maxRejections) return null;
  const command = previewRecheckCommand(latestPreview, { requireInteraction });

  if (latestPreview.generation !== workspaceGeneration) {
    return `You called done after workspace changes since your last preview. That rendered evidence is stale. Run \`query "${command}"\` against the current entry (choose the deliverable if that preview was a temporary check), fix anything it reports, and only then finish.`;
  }

  if (latestPreview.status === "pass") {
    if (requireInteraction && latestPreview.mode !== "interact") {
      return `You called done after only a load-only preview, but this task asks for an interactive web experience. A clean initial render does not prove its advertised controls or state transitions work. Run \`query "${command}"\`, fix any interaction issues it reports, and repeat that interactive preview on the current files before finishing.`;
    }
    return null;
  }
  if (latestPreview.status === "offline-external-dependency") {
    return "You called done, but the current preview is blocked by an external browser dependency while preview networking is disabled. This does NOT mean the CDN URL is bad, and changing CDN providers cannot help. Vendor/preinstall the dependency locally, or tell the operator to restart Bantam with --shell-network; then preview the current page again before claiming it works.";
  }
  if (latestPreview.status === "empty") {
    return `You called done, but the current preview rendered an essentially empty page. Fix the render and run \`query "${command}"\` again before finishing.`;
  }
  if (latestPreview.status === "visual-fail") {
    const review = latestPreview.visualReview ?? {};
    const details = [review.summary, ...(review.issues ?? [])]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" ");
    return `You called done, but the screenshot reviewer found a clear visual defect${details ? `: ${details}` : "."} Fix the rendered page and run \`query "${command}"\` again before finishing.`;
  }
  if (latestPreview.status === "pointer-obstruction") {
    const details = (latestPreview.pointerOcclusions ?? [])
      .slice(0, 3)
      .map((item) => {
        const control = item?.control?.text || item?.control?.id || item?.control?.tag || "control";
        const blocker = item?.blocker?.text || item?.blocker?.id || item?.blocker?.tag || "another element";
        return `${control} is covered by ${blocker}`;
      })
      .join("; ");
    return `You called done, but Chromium's pointer hit-test found a visible control obstruction${details ? `: ${details}.` : "."} Fix the stacking or pointer-events defect and run \`query "${command}"\` again before finishing.`;
  }
  if (latestPreview.status === "interaction-inconclusive") {
    return `You called done, but the requested interaction smoke did not complete, so the controls remain unverified. Run \`query "${command}"\` again and only finish after it completes cleanly.`;
  }
  if (latestPreview.status === "interaction-timeout") {
    const details = (latestPreview.interactionIssues ?? [])
      .slice(0, 3)
      .map((issue) => String(issue).trim())
      .filter(Boolean)
      .join(" ");
    return `You called done, but the bounded interaction preview timed out${details ? `: ${details}` : "."} A single timeout is inconclusive: rerun the same \`query "${command}"\` once before editing. If it repeats at the same control, investigate that handler, fix any confirmed defect, and preview again before finishing.`;
  }
  if (latestPreview.status === "interaction-problems") {
    const details = (latestPreview.interactionIssues ?? [])
      .slice(0, 3)
      .map((issue) => String(issue).trim())
      .filter(Boolean)
      .join(" ");
    return `You called done, but the interaction preview found working-behavior defects${details ? `: ${details}` : "."} Fix them, then run \`query "${command}"\` again against the current files before finishing.`;
  }
  return `You called done, but the current preview still reports browser errors or failed resources. Fix those concrete problems and run \`query "${command}"\` again before finishing.`;
}

/**
 * Keep the requirement narrow: only rendered web work with explicit interaction
 * language needs the extra smoke. Non-web games and ordinary informational pages
 * are unaffected, and the gate cannot fire until a preview proof exists.
 */
export function taskRequiresInteractivePreview(task) {
  const text = String(task ?? "");
  const web = /\b(browser(?:-based)?|web(?:site|app|page)?|html|canvas|three(?:\.?js)?|javascript|ui)\b/i.test(text);
  const interaction = /\b(game|playable|interactive|controls?|keyboard|mouse|click|drag|pause|resume|move|rotate|drop)\b/i.test(text);
  return web && interaction;
}

/** Visual browser deliverables need a rendered checkpoint even when static. */
export function taskRequiresVisualPreview(task) {
  const text = String(task ?? "");
  const visual = /\b(canvas|svg|voxel|pagoda|scene|illustration|image|visual|animation|game|pixel[- ]?art)\b/i.test(text);
  const web = /\b(html|canvas|svg|browser|web(?:site|app|page)?|javascript)\b/i.test(text);
  return visual && web;
}
