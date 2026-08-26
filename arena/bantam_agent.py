import os
"""Harbor adapter: BANTAM as a Terminal-Bench entrant.

The entrant is the FACTORY, not the model: bantam's full harness (grammar-
constrained actions, verify gates, repair turns, grounding) runs inside the
task container, talking to the operator's local llama-server on the host.

Wiring notes, each one load-bearing:
- Artifacts (node runtime + bantam source) are served from the HOST at
  port 8378, so installs need no external network and are byte-identical
  across tasks. The host is reached at the container's default gateway.
- BANTAM_SHELL_SANDBOX=host: inside the task container there is no docker
  daemon; the container itself is the sandbox.
- BANTAM_MODEL_LOCK=0: the in-container lock would be meaningless (each
  container has its own /tmp) and the run is serialized host-side by
  --n-concurrent 1 instead.
- The instruction travels via env var, never shell interpolation.
"""

import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

ARTIFACT_PORT = 8378
MODEL_PORT = 8085

# Gateway detection with no binary dependencies: /proc/net/route exists in
# every Linux container even when iproute2 does not (the first smoke died at
# exit 127 on a slim image missing `ip`). Hex little-endian -> dotted quad,
# with the standard docker bridge as the final fallback.
_GATEWAY_SNIPPET = (
    "GWH=$(awk '$2==\"00000000\"{print $3; exit}' /proc/net/route 2>/dev/null); "
    'if [ -n "$GWH" ]; then '
    'GW=$((16#${GWH:6:2})).$((16#${GWH:4:2})).$((16#${GWH:2:2})).$((16#${GWH:0:2})); '
    "else GW=172.17.0.1; fi"
)


class BantamAgent(BaseInstalledAgent):
    """BANTAM: a scrappy little terminal agent, entered as a full factory."""

    @staticmethod
    @override
    def name() -> str:
        return "bantam"

    @override
    def get_version_command(self) -> str | None:
        return "node /opt/bantam/bin/bantam.js --version 2>/dev/null || echo bantam-factory-dev"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "export DEBIAN_FRONTEND=noninteractive; "
                "command -v curl >/dev/null || (apt-get update && apt-get install -y curl) || true; "
                # Provide common tools when the container allows it, so
                # the agent is not hamstrung reaching for an absent one
                # (the missing-tool steer is the fallback when this fails).
                "command -v python3 >/dev/null || (apt-get install -y python3 >/dev/null 2>&1) || true; "
                f'{_GATEWAY_SNIPPET}; '
                'echo "gateway: $GW"; '
                f"curl -fsS http://$GW:{ARTIFACT_PORT}/node-v20.tar.gz -o /tmp/node.tar.gz && "
                "mkdir -p /opt/node && tar xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 && "
                f"curl -fsS http://$GW:{ARTIFACT_PORT}/bantam.tgz -o /tmp/bantam.tgz && "
                "mkdir -p /opt/bantam && tar xzf /tmp/bantam.tgz -C /opt/bantam && "
                # PYTHON: keep the IMAGE's interpreter when it has one. The portable
                # python used to be installed UNCONDITIONALLY and symlinked over
                # /usr/local/bin/python3 — which in 36 of 79 task images is where the
                # image's OWN python lives (python:3.x-slim puts it there). That did
                # not shadow the task's environment, it overwrote it. build-cython-ext
                # (2026-08-21) is literally about "my system's global Python
                # environment" with numpy==2.3.0; we replaced that interpreter with
                # 3.11 + numpy 2.4.6 at install time and the grader asserted on OUR
                # numpy. Four defects today trace to this one choice: Pillow hidden,
                # cp312 wheels in a 3.11 tree, pytest off PATH, numpy version changed.
                # 52 of 74 images ship python3; for them the portable copy is not a
                # fallback, it is a substitution. Install it only when there is none.
                # HAVING python3 is the whole test. Requiring a working pip too was
                # wrong and cost runs: mailman's image ships python 3.12.3 with the
                # mailman package importable and NO pip and no ensurepip, so the
                # pip clause failed, the portable python was symlinked over
                # /usr/local/bin/python3, and `import mailman` stopped working —
                # we replaced the interpreter holding the task's own library. The
                # run had to discover /usr/bin/python3 by hand to get its job done.
                # Never replace an interpreter the image already has; if it lacks
                # pip, GIVE it pip.
                "if command -v python3 >/dev/null 2>&1; then "
                'echo "python: keeping the image\'s own $(command -v python3) ($(python3 --version 2>&1))"; '
                # PEP 668 images refuse a bare `pip install`; the model must be able to
                # install what it reaches for, so make break-system-packages the default
                # ONLY where that marker exists (it is the environment the task author
                # built; we are not replacing it, just making it writable).
                "if ls /usr/lib/python3*/EXTERNALLY-MANAGED >/dev/null 2>&1; then "
                "printf '[global]\\nbreak-system-packages = true\\n' > /etc/pip.conf; fi; "
                # The image's python may have no pip at all (mailman: no pip, no
                # ensurepip). Provide it rather than swapping the interpreter:
                # ensurepip, then apt, then get-pip. Any failure is tolerated —
                # the portable python at /opt/python/bin/python3 stays available
                # for tooling, and the module-missing steer names it.
                'if ! python3 -m pip --version >/dev/null 2>&1; then '
                'python3 -m ensurepip --default-pip >/dev/null 2>&1 '
                '|| (apt-get update >/dev/null 2>&1 && apt-get install -y python3-pip >/dev/null 2>&1) '
                '|| true; fi; '
                'echo "python: pip $(python3 -m pip --version 2>&1 | head -1)"; '
                "else "
                # Portable Python (3.11, stdlib) served from the artifact server, so
                # the agent HAS python3 when it reaches for it to compute a reference
                # value, parse a binary format with struct, or build a quick helper.
                # The task container is offline, so apt cannot supply it — and a tool
                # the model reaches for to do its job should be PROVIDED, not steered
                # away from (operator, 2026-08-20).
                f"curl -fsS http://$GW:{ARTIFACT_PORT}/python.tar.gz -o /tmp/python.tar.gz && "
                "mkdir -p /opt/python && tar xzf /tmp/python.tar.gz -C /opt/python --strip-components=1 && "
                "ln -sf /opt/python/bin/python3 /usr/local/bin/python3 && "
                "ln -sf /opt/python/bin/python3 /usr/local/bin/python && "
                # pip MUST point at the portable python, or `pip install X` lands in
                # the base image's system python while the model's `python3` runs the
                # portable one -> ModuleNotFoundError (break-filter couldn't import
                # bs4 that filter.py needs; count-dataset-tokens only survived by
                # luckily using `python3 -m pip`). Symlink pip/pip3 to /opt/python.
                #
                # BUT the pip3 wrapper is a polyglot whose sh line re-execs
                # "$(dirname $0)/python3.11" -- so a bare symlink of pip into
                # /usr/local/bin makes it hunt /usr/local/bin/python3.11 and die
                # `exec: /usr/local/bin/python3.11: not found`. largest-eigenval
                # (2026-08-20) reached for `pip install scipy` (the LAPACK tool it
                # said it needed) and got exactly that error -- a tool the model
                # reaches for, denied by our own wiring. Put python3.11 where the
                # wrapper looks, next to the pip symlink; proven live: pip then
                # reports "python 3.11" and installs land where `python3` imports.
                "ln -sf /opt/python/bin/python3.11 /usr/local/bin/python3.11 && "
                # NOT a bare symlink: a pip wrapper that also links the console
                # scripts it installs into /usr/local/bin. Scripts land in
                # /opt/python/bin, which is NOT on PATH in these images, and that
                # broke the GRADER rather than the agent — kv-store-grpc's own
                # tests/test.sh runs `pip install pytest…` then `pytest`, hit
                # "pytest: command not found", and scored 0 regardless of what
                # BANTAM had built. build-cython-ext has the same shape.
                "echo IyEvYmluL3NoCiMgcGlwIHRoYXQga2VlcHMgaXRzIGNvbnNvbGUgc2NyaXB0cyBSRUFDSEFCTEUuCiMKIyBUaGUgYWRhcHRlciBwb2ludHMgcHl0aG9uMy9waXAgYXQgdGhlIHBvcnRhYmxlIC9vcHQvcHl0aG9uLCBzbyBhbnl0aGluZyBwaXAKIyBpbnN0YWxscyBwdXRzIGl0cyBjb25zb2xlIHNjcmlwdHMgaW4gL29wdC9weXRob24vYmluIOKAlCB3aGljaCBpcyBub3Qgb24gUEFUSCBpbgojIHRoZXNlIGltYWdlcy4gVGhhdCBzaWxlbnRseSBicm9rZSB0aGUgR1JBREVSLCBub3QgdGhlIGFnZW50OiBrdi1zdG9yZS1ncnBjJ3MKIyBvd24gdGVzdHMvdGVzdC5zaCBkb2VzIGBwaXAgaW5zdGFsbCBweXRlc3TigKZgIHRoZW4gcnVucyBgcHl0ZXN0YCwgZ290CiMgInB5dGVzdDogY29tbWFuZCBub3QgZm91bmQiLCBhbmQgc2NvcmVkIDAgbm8gbWF0dGVyIHdoYXQgQkFOVEFNIGhhZCBidWlsdC4KIyBMaW5rIGFueXRoaW5nIG5ldyBpbnRvIC91c3IvbG9jYWwvYmluICh3aGljaCBpcyBvbiBQQVRIKSBhZnRlciBldmVyeSBpbnN0YWxsLgovb3B0L3B5dGhvbi9iaW4vcGlwMyAiJEAiCnJjPSQ/CmZvciBmIGluIC9vcHQvcHl0aG9uL2Jpbi8qOyBkbwogIFsgLXggIiRmIiBdIHx8IGNvbnRpbnVlCiAgYj0kKGJhc2VuYW1lICIkZiIpCiAgY2FzZSAiJGIiIGluIHB5dGhvbip8cGlwKikgY29udGludWU7OyBlc2FjCiAgWyAtZSAiL3Vzci9sb2NhbC9iaW4vJGIiIF0gfHwgbG4gLXNmICIkZiIgIi91c3IvbG9jYWwvYmluLyRiIgpkb25lCmV4aXQgJHJjCg== | base64 -d > /usr/local/bin/pip.new && "
                # BOTH names are removed first. In several images /usr/local/bin/pip
                # is a symlink to pip3 (or a hardlink), so writing one and deleting
                # the other leaves a dangling link and aborts the whole && chain —
                # the run would never start at all.
                "chmod +x /usr/local/bin/pip.new && rm -f /usr/local/bin/pip /usr/local/bin/pip3 && "
                "cp /usr/local/bin/pip.new /usr/local/bin/pip && cp /usr/local/bin/pip.new /usr/local/bin/pip3 && "
                "rm -f /usr/local/bin/pip.new && "
                "true; fi && "
                "ln -sf /opt/node/bin/node /usr/local/bin/node && "
                "node -v && python3 --version && "
                # the model must be reachable before we call the install good
                f"curl -fsS -m 5 http://$GW:{MODEL_PORT}/health"
            ),
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = {
            "HARBOR_INSTRUCTION": instruction,
            "BANTAM_SHELL_SANDBOX": "host",
            "BANTAM_MODEL_LOCK": "0",
            # Network is ALLOWED by default — the containers have public internet and
            # a large share of the bench legitimately needs it (huggingface datasets,
            # pip installs, model downloads). count-dataset-tokens failed at reward 0
            # because a blanket BANTAM_SHELL_NETWORK=0 (added for gpt2 integrity)
            # refused 189 of its 72 download attempts. Integrity blocking is a PER-TASK
            # concern, not a global one: set BANTAM_SHELL_NETWORK=0 only for
            # reimplement-from-scratch tasks where downloading the reference solution
            # would invalidate the benchmark (gpt2-codegolf and kin).
            "BANTAM_SHELL_NETWORK": os.environ.get("BANTAM_SHELL_NETWORK", "1"),
            # TB2 audit (2026-08-20): a hung generated program (write-compressor's
            # gen.js had an infinite loop) ate the whole agent budget because the
            # default per-command shell timeout is 600s. Cap it to 90s so a
            # runaway subprocess dies fast and the model gets to react and debug.
            # 90s was too tight for tasks whose CORE operation legitimately runs
            # for minutes. rstan-to-pystan (2026-08-21) had its MCMC sampling killed
            # at 43%, backgrounded it exactly as our own steer advises, and then had
            # the POLL (`sleep 90 && tail`) killed by the same cap at 85% sampled —
            # following the advice correctly still failed. 300s keeps a runaway from
            # eating the budget while letting a real computation finish; the steer is
            # now cap-aware and suggests a poll comfortably under whatever this is.
            "BANTAM_SHELL_TIMEOUT_MS": os.environ.get("BANTAM_SHELL_TIMEOUT_MS", "300000"),
            # TB2 audit (2026-08-20): the local-llama.cpp prefix cache died three
            # ways, each masking the next; all were CONTEXT, never the model.
            #   1. Server was --parallel 4 (crew). A local slot has
            #      checkpoint-or-nothing reuse, so a solo run scattered across 4
            #      cold slots -> cache_n=0, full ~26k reprocess/turn, 45-min TIMEOUT
            #      on a task the model could do. Fix: certified --parallel 1 stack
            #      (launch-bantam-q4.sh). Proven: 3501-token prefix reused 100%.
            #   2. BANTAM_IMMUTABLE_HISTORY=1 alone was NOT enough: it freezes
            #      history but the prompt is still "rebuild" trajectory, so volatile
            #      sections (the open-files panel) shift byte positions and cache_n
            #      plateaus at the static menu (~2168) while the growing context
            #      reprocesses -> back to 24-41s/turn at depth.
            #   3. The real switch is the prompt TRAJECTORY. "extension" makes each
            #      prompt a byte-level extension of the prior (frozen head, no
            #      volatile tail, open-files panel folded into observations) ->
            #      ~92% slot reuse, <half wall time (agent.js:359,694). It is
            #      deliberately OFF by default because "rebuild" scores higher on
            #      repair-heavy tasks (the live panel avoids stale self-knowledge) --
            #      but rebuild's cache-death TIMES OUT here, and a finished run at
            #      slightly lower accuracy beats a timeout at 0. Bare-history think
            #      remedy is default-on in extension mode, so this one flag suffices.
            "BANTAM_PROMPT_TRAJECTORY": "extension",
            # Point the model at an available reference tool when debugging exact
            # numerics instead of guessing (TB2 gpt2 timed out doing the latter);
            # layout-selfcheck breaks the "LN gamma ~= 1" false-prior trap that
            # made it thrash locating weights in a headerless dump.
            # render-decode closes the instrument gap on image-grounded tasks:
            # view_image is a STOCHASTIC gauge (measured ~1-in-6 exact on
            # chess-best-move's rendered board), and the deterministic decode
            # against the font still on disk was 13/13. The rule teaches the
            # technique; the vision_unverified done-gate enforces it.
            # scaffold-first is the deepest of the three: it attacks the STRUCTURAL
            # failure (guess-and-check the whole program) by forcing a cheap oracle +
            # gated stage-by-stage build — build the wheelbarrow before moving the dirt.
            "BANTAM_RULES": os.environ.get(
                "BANTAM_RULES", "reference-verify,layout-selfcheck,scaffold-first,precise-diff,constraint-recheck,job-liveness,verify-outputs,automate-search,render-decode,compute-dont-reason,source-not-rendering,measure-like-the-grader,canonical-archive-first,count-is-not-additive,as-of-date-needs-archived-data,tune-the-knobs-you-control,check-cannot-assume-your-construction"
            ),
            "BANTAM_MAX_TURNS": os.environ.get("BANTAM_MAX_TURNS", "120"),
            # Which resume artifact to fetch. Per-chain, because two chains now
            # run concurrently and a single shared resume-run.json would let one
            # chain hand the other's dialogue to a task — a run continuing
            # SOMEONE ELSE'S history, which no verdict would explain.
            "BANTAM_RESUME_NAME": os.environ.get("BANTAM_RESUME_NAME", "resume-run.json"),
        }
        # Resume mode: when BANTAM_RESUME=1, a run truncated by the clock continues
        # from its own checkpoint instead of starting cold. The bundle (prior
        # run.json + the workspace files the schema-2 checkpoint could not embed) is
        # staged on the artifact server; we fetch it, drop the files into /app beside
        # the task's own weights/vocab, and hand bantam --resume-run so the dialogue
        # AND the built-up gpt2.c both come back. `curl` here runs in the harness
        # shell (not bantam's sandbox), so the model's network guard does not apply.
        resume = os.environ.get("BANTAM_RESUME", "0") == "1"
        common_head = (
            f'{_GATEWAY_SNIPPET}; '
            f"export BANTAM_ENDPOINT=http://$GW:{MODEL_PORT}; "
            'cd /app 2>/dev/null || cd "$HOME"; '
            "mkdir -p /tmp/bantam-evidence; "
        )
        if resume:
            # Generalized (2026-08-21). This used to be hardcoded to gpt2: it
            # fetched resume-gpt2.c into /app and could resume nothing else. Now
            # the saved artifact carries its own workspaceSnapshot (agent-authored
            # files, lean by construction) and bin/bantam.js rebuilds them into
            # --workspace on --resume-run, so the ONLY thing staged on the
            # artifact server is the run.json. write-compressor had a green
            # round-trip at 3015 bytes, 515 over the cap, when the clock cut it at
            # turn 99 — every restart threw that away.
            run_command = (
                common_head
                + f'curl -fsS http://$GW:{ARTIFACT_PORT}/"$BANTAM_RESUME_NAME" -o /tmp/resume-run.json && '
                + 'echo "RESUMING: run.json staged; bantam rebuilds the workspace from its embedded snapshot"; '
                + 'node /opt/bantam/bin/bantam.js run --resume-run /tmp/resume-run.json '
                + '--task "$HARBOR_INSTRUCTION" --workspace /app --autonomous '
                + '--max-turns '"${BANTAM_MAX_TURNS:-400}"' '
                + "--save-run=/tmp/bantam-evidence/run.json 2>&1 | tee /tmp/bantam-evidence/stream.log; "
                + 'exit "${PIPESTATUS[0]}"'
            )
        else:
            run_command = (
                common_head
                # Evidence or it didn't happen: full stream tees to a file and
                # bantam saves its own run record — both pulled as artifacts.
                + 'node /opt/bantam/bin/bantam.js run --task "$HARBOR_INSTRUCTION" '
                + '--workspace "$(pwd)" --autonomous --max-turns '"${BANTAM_MAX_TURNS:-120}"' '
                + "--save-run=/tmp/bantam-evidence/run.json 2>&1 | tee /tmp/bantam-evidence/stream.log; "
                + 'exit "${PIPESTATUS[0]}"'
            )
        await self.exec_as_root(
            environment,
            command=run_command,
            env=env,
            # This exec cap, not the agent budget, was the real ceiling: at
            # agent-timeout-multiplier 5.0 the agent budget is 4500s but a
            # hardcoded 3000s here fired first, cutting clean-progress runs at
            # 50 min and surfacing as a RuntimeError I twice misread as a model
            # fail. Set above the agent budget so the agent's own timeout binds.
            timeout_sec=6000,
        )
