# Fight-card archive and publication policy

The old generated fight cards, replay pages, raw logs, evidence archives,
showcases and share images have been moved to a private local archive outside
this repository. Historical result discussions elsewhere in the documentation
refer to those archived runs, not to a currently distributed public showcase.
Reusable work orders, graders and generators remain in the repository.

New cards will be generated from fresh runs and reviewed before publication.
Keep raw evidence outside tracked documentation (for example under the ignored
`.bantam/` directory). Do not publish raw prompts, workspaces, machine paths,
account details, credentials or embedded evidence bundles by default. Inspect
compressed and encoded attachments as well as visible page content. Sanitized
cards must retain truthful scores, accounting completeness, failures and timing;
privacy cleanup is not permission to improve a result or silently alter sealed
evidence. Keep original evidence private and identify sanitized derivatives.

Generated files here are ignored to prevent accidental reintroduction. Adding
a reviewed public package must be an explicit publication decision.

## Release blocker: Git history

Moving files out of the current tree does not erase previous Git commits.
The existing repository must remain private until the complete privacy audit
and an explicitly approved history-cleanup or clean-public-repository process
are finished. This move is not a secret-scan clearance.

See [bring-your-own comparisons](../BRING-YOUR-OWN-COMPARISONS.md) to generate
new local cards, and [launch readiness](../LAUNCH-READINESS.md) for remaining work.
