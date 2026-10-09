## What changed

- DiffusionGemma primary chat/work now uses a lean prompt without a duplicate JSON tutorial or tool manual. User requests, operator preferences, selected rules and actual verification evidence remain available. Jev receives legal options when selecting operations; the CPU continues assembling and validating actions.
- The 16,384-token deployment allows **8,192 tokens for thinking plus output**, with a **1,024-token safety margin** and a **7,168-token input ceiling**. History trims near **5,376** input tokens toward **4,032**. Replies and source generation can use the full reserve; multiple generated fields share it.
- Jev handle reads budget their exact input and small output canvas separately. Required user/source context is never silently truncated to squeeze a request through.
- The model menu reports the deployed budgets; prior-session history is smaller. Other chat backends retain their existing prompts and budgets.

## Validation

- Full regression suite: **5,170 passed, 0 failed, 252 skipped** (5,422 tests total).
- Real server tokenization of a simple chat prompt: **1,578 → 161 input tokens**, about **90% less**.
- Real DiffusionGemma chat, thinking, hidden-thought streaming, simultaneous Jev/chat, context rejection and history trimming passed. The small coding task passed all six independent checks in **7.1 seconds**, preserving its test file.
- Tetris with the lean prompt and 8K allowance wrote a file, but failed independent syntax checks and did not qualify. Larger tasks remain model-dependent; the bigger generation allowance does not guarantee correct code.

Restart BANTAM after updating. See [Jev mode](https://github.com/BANTAM-ADMIN/bantam-factory/blob/main/docs/JEV-MODE.md) for the working context limits.
