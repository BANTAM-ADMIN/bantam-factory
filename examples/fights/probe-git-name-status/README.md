# Changed-path selection experiment

This is a small instrument-adoption pilot, not a general capability benchmark.
Both conditions receive identical task and starter bytes; only the optional
`probe` action differs. The task explicitly requests experimental evidence, so
the experiment measures instructed use, not spontaneous tool discovery.

Run `node scripts/probe-pilot.mjs /absolute/new/evidence-directory` from BANTAM.
The pilot uses the existing local-27B fight launcher, offline Docker execution,
saved runs, protected starter hashes, and independent read-only acceptance.
One pair cannot qualify a default change or establish a statistical speedup.
Raw evidence stays under the ignored `.bantam/acceptance/` tree.
