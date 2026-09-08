# Context packet · fight card

[Open the fight](share/index.html) · [Measurements](share/fight-card.json)

Actions, delivered files, test output and the story of each attempt are inside the card.

| System | Outcome | Time | Independent groups |
|---|---|---:|---:|
| BANTAM FACTORY · local | PASS | 58.1 s | 5/5 |
| OpenCode | OUTPUT_ONLY | 600.0 s | 5/5 |
| Codex · Astra | PASS | 110.6 s | 5/5 |
| DeepSeek Harness | OUTPUT_ONLY | 600.0 s | 5/5 |
| Hermes | PASS | 512.2 s | 5/5 |
| Pi | PASS | 350.7 s | 5/5 |

Pi 0.85.1 ran on September 8, 2026 with the same frozen task, starter, independent checks and local model weights. It used its native CLI, tools and prompts, a ten-minute limit, a 32,768-token response allowance and a 65,536-token declared context. The shared server served 72,192 tokens on the RTX 4090 and stayed warm between runs. Every planned Pi attempt is included.

<details>
<summary>Recording conditions</summary>

BANTAM FACTORY was qualified first on this development work order. Follow-up contenders received the same frozen task, starting files, independent checks and local model bytes, without manual repairs. Codex uses the cloud model named in its row. Replay clocks align the starts of separately recorded runs.

Native prompts, tools, sampling and compaction apply. BANTAM FACTORY uses separate requests allowing up to 4,096 reasoning tokens and 8,192 action tokens. Challenger clients use a 32,768-token response allowance. Local inference runs serially on the existing warm server.

PASS requires accepted work and a clean finish. OUTPUT_ONLY means the files passed but the attempt did not complete. Timeouts show the stopping boundary. Missing counters stay unknown; partial timing coverage is marked inside each lane.

[Earlier recording notes](https://github.com/BANTAM-ADMIN/bantam-factory/blob/87d9cc999ae0ffb585801764ae6d2b4fb42cb0ae/docs/fights/launch-2026-09-07/context-packet/README.md) · [Task, model and recording hashes](share/fight-card.json)

</details>
