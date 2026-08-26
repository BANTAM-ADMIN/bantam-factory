import assert from "node:assert/strict";
import test from "node:test";

import { isSourcePath, shellWritesSourceFile } from "../src/edit-actions.js";

test("isSourcePath recognizes compilable/runnable source extensions", () => {
  for (const p of ["/app/gpt2.c", "main.cpp", "x.py", "a/b/mod.rs", "s.go", "t.js", "h.hpp"]) {
    assert.equal(isSourcePath(p), true, p);
  }
  for (const p of ["/tmp/log.txt", "notes.md", "data.json", "gpt2-124M.ckpt", "vocab.bpe", ""]) {
    assert.equal(isSourcePath(p), false, p);
  }
});

test("shellWritesSourceFile catches the heredoc/redirect rewrite that slipped the gate", () => {
  // The exact 2026-08-20 failure shape: rm then heredoc-rewrite the whole file.
  assert.equal(shellWritesSourceFile("rm -f /app/gpt2.c; cat > /app/gpt2.c << 'EOF'\nint main(){}\nEOF"), true);
  assert.equal(shellWritesSourceFile("cat > gpt2.c << EOF"), true);
  assert.equal(shellWritesSourceFile("printf '%s' \"$SRC\" > main.c"), true);
  assert.equal(shellWritesSourceFile("echo done >> build.sh"), true);
  assert.equal(shellWritesSourceFile("tee solve.py < /tmp/x"), true);
  assert.equal(shellWritesSourceFile("tee -a mod.rs"), true);
  assert.equal(shellWritesSourceFile("sed -i 's/a/b/' gpt2.c"), true);
  assert.equal(shellWritesSourceFile("dd if=/tmp/x of=out.cpp"), true);
});

test("shellWritesSourceFile does NOT fire on builds, runs, or inspection", () => {
  // A compile is not a write — it must not count as an edit (it RESETS the gate).
  assert.equal(shellWritesSourceFile("gcc -O3 gpt2.c -lm -o a.out"), false);
  assert.equal(shellWritesSourceFile("./a.out gpt2-124M.ckpt vocab.bpe \"hello\""), false);
  assert.equal(shellWritesSourceFile("od -A d -t x1 gpt2-124M.ckpt | head -40"), false);
  assert.equal(shellWritesSourceFile("wc -c gpt2.c"), false);
  assert.equal(shellWritesSourceFile("cat gpt2.c"), false);            // read, not write
  // redirect to a NON-source file must not count as a source write.
  assert.equal(shellWritesSourceFile("echo hi > /tmp/log.txt"), false);
  assert.equal(shellWritesSourceFile("gcc gpt2.c 2>&1 | head"), false);
});
