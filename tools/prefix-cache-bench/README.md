# prefix-cache-bench

The rig that produced [docs/LLAMA-CPP-PREFIX-CACHE-CONTROLS.md](../../docs/LLAMA-CPP-PREFIX-CACHE-CONTROLS.md).

The definitive gauge is `timings.cache_n` — tokens the server restored instead of
re-prefilling. Never `tok/s`: effective throughput mixes prefill and generation
and has lied about this exact question before.

## Rig

`lab-server.sh` launches a llama-server that mirrors the certified solo stack but
makes every cache knob settable. **It never edits the operator's launch scripts.**

```bash
./lab-server.sh --label ub2048 --ubatch 2048 --ctx 72000
./lab-server.sh --label crew  --parallel 4 --unified --ctx 140000
./lab-server.sh --label text  --no-vision --slot-save ./slotstates
```

Flags: `--port --ctx --parallel --ubatch --batch --ckpts --minstep --cacheram
--reuse --no-vision --unified --no-mtp --slot-save DIR --sleep-idle N --label`

## Experiments

| script | question |
|---|---|
| `e1.py` | the four prompt shapes BANTAM actually emits |
| `e2.py` | token-exact divergence sweep — how late must a change be? |
| `e3.py` | do user-message boundaries create usable checkpoints? |
| `e4.py` | does a busy sibling slot evict an idle slot? (unified vs split) |
| `e5.py` | explicit prefix points via `/slots/{id}?action=save\|restore` |

```bash
python3 e1.py http://127.0.0.1:8085 0,256 results/e1-mine.jsonl
python3 e2.py http://127.0.0.1:8085 results/e2-mine.jsonl 0,256,512,1024,2048
```

`results/` holds the raw JSONL from the 2026-08-22 run, one object per request
with the full telemetry.

## Two traps this rig exists to avoid

1. **Read the error body.** `e5.py` first reported a bare `HTTP Error 501`; the
   body said `"This feature is not supported by multimodal"` — a completely
   different conclusion. The scripts print bodies now.
2. **Force generation.** These prompts end at `Assistant:` and the model emits
   EOS immediately, so `predicted_ms` comes back `0` and the tok/s column reads
   `1000000`. Every request sets `ignore_eos`.
