import assert from "node:assert/strict";
import test from "node:test";
import { classifyNetworkFetch } from "../src/offline-install.js";

test("blocks downloading the reference from the internet", () => {
  for (const c of [
    "python3 -c \"import urllib.request; urllib.request.urlopen('https://raw.githubusercontent.com/openai/gpt-2/master/src/encoder.json')\"",
    "curl -fsSL https://huggingface.co/gpt2/resolve/main/vocab.json -o v.json",
    "wget https://github.com/openai/gpt-2/raw/master/src/model.py",
    "git clone https://github.com/openai/gpt-2",
    "python3 -c 'import requests; requests.get(\"https://example.com/ref\")'",
  ]) assert.ok(classifyNetworkFetch(c), c);
});

test("allows local / offline commands", () => {
  for (const c of [
    "gcc -O3 -lm gpt2.c -o a.out",
    "./a.out gpt2-124M.ckpt vocab.bpe \"hello\"",
    "python3 -c 'import numpy as np; print(np.zeros(3))'",
    "od -A d -t x1 gpt2-124M.ckpt | head",
    "cat vocab.bpe | wc -l",
    "curl -s http://127.0.0.1:8085/health",   // local model, allowed
    "echo https://example.com > note.txt",     // a URL in text, no fetcher
  ]) assert.equal(classifyNetworkFetch(c), null, c);
});
