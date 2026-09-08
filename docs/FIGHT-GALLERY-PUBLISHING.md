# The public fight gallery

**[Open the live gallery](https://bantam-admin.github.io/bantam-factory/)**

The gallery is a static GitHub Pages site. It loads no external assets and has
no backend or telemetry. The same self-contained pages work offline.

## Update the presentation

The gallery, public replay, live board and detailed replay share their visual
language through `scripts/fight-design.mjs`. The public replay and share image
are rendered by `scripts/factory-launch-page.mjs`; the gallery is rendered by
`scripts/factory-fight-gallery.mjs`.

Rebuild the existing reviewed packages into a **fresh** directory:

```bash
node scripts/refresh-fight-presentation.mjs \
  "$PWD/docs/fights/launch-2026-09-07" \
  "$PWD/.bantam/presentation-preview" \
  /absolute/path/to/chromium
```

This validates the input packages, regenerates HTML and share graphics, and
updates presentation hashes in the new output. It preserves the original
showcase JSON, downloadable measurements and source seals byte for byte.
It does not run models, overwrite the input, add unpublished tasks, or upload.
The browser runs with its own profile and GPU acceleration disabled.

### Hardware and generation speed

Public cards can carry allowlisted hardware and numeric server-timing receipts.
The published local 27B runs used an operator-confirmed RTX 4090 with 24 GB VRAM,
Q4_K_P weights and 72,192 configured context tokens. Hosted contenders do not
inherit that GPU label.

Generation speed is the sum of recorded `predicted_n` divided by the sum of
`predicted_ms` in seconds. Fresh prompt speed uses `prompt_n` and `prompt_ms`.
These are weighted phase rates, separate from the full task clock. Every rate
carries measured-request coverage; incomplete coverage stays a labeled subset.
The exporter re-reads hash-verified response bodies, including streamed responses.
It does not average request rates, count cache hits as fresh processing, or
substitute total task time for generation time.

Fresh showcase exports derive timing receipts automatically. To confirm the
hardware for a settled local run, add `--local-hardware rtx-4090-24gb` to the
`factory-showcase.mjs` command. This is an explicit operator assertion; the
exporter's current GPU is never used as historical evidence.

An optional fourth argument to `refresh-fight-presentation.mjs` accepts a reviewed
`bantam.fight-performance-supplement.v1` JSON file. Each card binds its original
public `sourceSha256`, and each local row binds `arm` and `wallMs` to the existing
result. Only the strict public performance fields are added. The fresh output
regenerates derived JSON and hash manifests; outcomes, clocks, and token totals
remain unchanged. Timings and the hardware assertion are included in the
downloadable public measurements. The supplement does not publish raw evidence.

Open the output's `index.html`. Check the gallery, a solo card where available,
a comparison, phone layout, replay controls, and image/JSON downloads. Copy
reviewed presentation changes back to the corresponding committed packages;
retain their refreshed manifests. Do not copy raw `.bantam` run directories.

## BANTAM first, comparisons later

One recorded BANTAM attempt is a complete solo card. It needs no placeholder
opponents. New competitor evidence must carry its own recorded conditions;
a later comparison must not turn missing attempts into failures or silently
replace earlier results.

`LAUNCH_SECTIONS` is the explicit public task list. Registering a task in the
factory catalog does not publish it. Add a new public section or card only
when its reviewed package is ready. Publication validates the complete listed
roster, retains failures, and keeps separately recorded references distinct.

## Publish an approved update

Normal commits do not redeploy the site. After reviewing and committing an
approved public update, use **Actions → Publish reviewed fight gallery → Run
workflow**, select `main`, and enable `publish_reviewed_gallery`.

The workflow stages only named assets from the reviewed packages. It refuses
private repositories, non-main refs, missing published cards, and mismatched
evidence or asset hashes. It does not upload the repository root, raw runs,
or arbitrary neighboring files.

After deployment, open the reported Pages URL and check a replay and both
downloads. The deployment result establishes what is live; a local preview
or successful commit alone does not.

The repository uses GitHub Actions as its Pages source. See
[GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
for hosting configuration.
