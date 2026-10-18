## What changed

### Team and trio use the current Sol and Luna

- **`:team`** now sends Luna and Sol scouts ahead of a single writer running the current Sol (`gpt-6.1-sol`). Terra no longer writes Team answers. Team sessions recorded with a Terra writer can still be applied.
- **`:trio`** runs local, Sol and Luna side by side. `bantam collaborate` reads both new trio sessions and older ones with a Terra lane.
- **Built-in model choices follow the newest Sol and Luna in your Codex account:** collaborate's teachers, factory build and cohort, foreman workers, gauntlet, the codexapi bridge menu, `:image`, Codex vision, compare, and the Codex fallback.
- **Terra runs only when you name it.** There is no GPT-6 Terra, so `terra` still means GPT-5.6-Terra.

### Quick help

- **`:help` no longer looks stuck.** The `bantam ❯` prompt returns after the help text. While a request is running, help prints above your input line.
- **`:max-turns [N]`** and **`:rea [on|off|status]`** are listed under Everyday.

## Validation

- Full regression suite: **5,232 passed, 0 failed, 251 skipped** (5,483 tests). CI passed on `main`.
- In a real terminal session: `:help` returns to the prompt, and `:team help` and `:trio help` show the Sol and Luna lanes.

Restart BANTAM after updating.
