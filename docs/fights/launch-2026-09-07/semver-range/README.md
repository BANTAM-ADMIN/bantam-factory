# Semver range · fight card

[Open the fight](share/index.html) · [Measurements](share/fight-card.json)

See each contender’s actions, delivered files, test output and short explanation inside the card.

| System | Outcome | Time | Independent groups |
|---|---|---:|---:|
| BANTAM · local | PASS | 399.9 s | 5/5 |
| Codex · Astra | PASS | 136.2 s | 5/5 |
| Hermes | OUTPUT_ONLY | 600.0 s | 5/5 |
| OpenCode | TIMEOUT | 600.0 s | No group report |
| DeepSeek Harness | PASS | 536.4 s | 5/5 |

<details>
<summary>Recorded conditions</summary>

BANTAM FACTORY was qualified first. The follow-up contenders received the same frozen task, starter and independent grader, using the same local Qwen 27B model bytes on an RTX 4090 with 24 GB VRAM and a 72,192-token server context. The original published results are retained.

DeepSeek Harness 0.1.2-rc.1, Hermes 0.20.0 and OpenCode 1.18.23 ran serially on September 8, 2026, with a ten-minute limit and 32,768-token response allowance. Their clients declared a 65,536-token context. Native tools, prompts, sampling and compaction policies apply. The existing server remained warm; its cache was not reset between attempts.

All planned follow-ups are included. PASS requires accepted work and a clean finish. Output only means the files passed but the run did not complete. Timeouts show the stopping boundary. Missing group reports remain unknown; the acceptance output records the underlying error.

Model, task and recording hashes accompany the measurements. Tool results and files are selected from saved records; machine paths are normalized. Private reasoning and account data stay in the original recording.

</details>
