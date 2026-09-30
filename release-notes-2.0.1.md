## What's new

- **API keys in one command:** `bantamfactory jev token` (`:jev token` in a session) shows the Jev API key, and creates one if there is none. `token new` replaces the key and `token clear` removes it. The key is saved in `~/.bantam/jev.json`, which is now readable only by you.
- **No restart for a new key:** a running Jev API picks up a new or removed key within a second. That covers both `bantamfactory jev serve` and `:jev on`, including a key changed from another terminal. An API open to the network never drops its key.
- **A welcome panel when Jev turns on:** `:jev on` and `bantamfactory jev serve` now print:
  - what Jev mode is;
  - the API address, the models and the key;
  - a curl request ready to paste;
  - what to try next.
- **Commands named `bantamfactory`:** Jev's help and messages now use `bantamfactory jev …`. `bantam jev …` still works.
- **Docs:**
  - the Jev guide moved to `docs/JEV-MODE.md` and is listed in the docs index;
  - the README restores the long-form overview and adds a Jev mode section;
  - research notes are no longer published.
- **CI:** fixed a clock race in the file-recency test. The preview screenshot test now reports why it failed.
- **Terminal version:** the splash, compact card and full banner show **2.0.1**.

## Validation

- Full local regression suite: **5,016 passed, 0 failed, 252 skipped** (5,268 tests total).
- Live on an RTX 4090 with DiffusionGemma:
  - A key created with `jev token` was required by `serve`: no key got 403, a wrong key 401, the right key 200. `/health` stayed open.
  - `token new` from a second terminal made the old key fail (401) and the new one work (200) without a restart.
  - `token clear` then opened the API again.
  - The panel's own curl request answered correctly, and `:jev on` then `:jev token` behaved the same in a session.

## Upgrade

```bash
git checkout main
git pull --ff-only
```

Restart BANTAM FACTORY to load the changes. Your Jev setup and model server are unchanged.
