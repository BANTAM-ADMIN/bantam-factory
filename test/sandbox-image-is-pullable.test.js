import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Executor, DEFAULT_SANDBOX_IMAGE } from "../src/executor.js";

// CI 2026-09-05, first green-field run of the suite gate. The default shell
// sandbox named `internal/api:latest` — a private image from an unrelated project
// that existed on exactly one developer's machine. Every shell action on every
// other machine returned:
//
//   sandbox: docker:internal/api:latest
//   exit 125
//   docker: Error response from daemon: No such image: internal/api:latest
//
// Nine tests failed, and — far worse — a fresh install could not execute a
// single shell command. It went unnoticed because the author's machine had the
// image cached, and because the workflow's push trigger named a branch the repo
// did not have, so the gate had never actually run.
//
// The image's CONTENTS were never load-bearing: the container is a bare rootfs
// and the toolchain is bind-mounted read-only from the host by toolMountArgs.
// The only real requirement is that any machine can pull it unattended.

test("the default sandbox image is an official Docker Hub library image", () => {
  // Official library images ("alpine:3", "debian:12") have no namespace slash and
  // pull unauthenticated on any host. A namespaced image ("internal/api:latest",
  // "myorg/thing") may be private, may not exist, and cannot be assumed pullable.
  assert.doesNotMatch(
    DEFAULT_SANDBOX_IMAGE,
    /\//,
    `default sandbox image "${DEFAULT_SANDBOX_IMAGE}" is namespaced — a fresh clone `
      + "cannot be assumed to pull it. Use an official library image.",
  );
  assert.match(DEFAULT_SANDBOX_IMAGE, /^[a-z0-9._-]+:[a-zA-Z0-9._-]+$/, "pin an explicit tag");
});

test("both sandbox call sites read the same default — no drift", () => {
  // The constructor and runShellProcess each defaulted the image independently.
  // Two literals meant a fix could land in one and miss the other.
  const src = fs.readFileSync(new URL("../src/executor.js", import.meta.url), "utf8");
  const literals = src.match(/BANTAM_DOCKER_IMAGE\s*\?\?\s*([^,;\n]+)/g) ?? [];
  assert.ok(literals.length >= 2, "expected both sandbox call sites to be present");
  for (const site of literals) {
    assert.match(site, /DEFAULT_SANDBOX_IMAGE/, `hardcoded image at call site: ${site}`);
  }
});

test("the executor's default image is the exported constant", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-img-"));
  try {
    assert.equal(new Executor(ws).dockerImage, DEFAULT_SANDBOX_IMAGE);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("BANTAM_DOCKER_IMAGE still overrides the default", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-img-"));
  try {
    assert.equal(new Executor(ws, { dockerImage: "debian:12" }).dockerImage, "debian:12");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
