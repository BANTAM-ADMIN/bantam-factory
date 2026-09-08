# The factory builds its toolbox

Proposed next fight series · September 8, 2026

**Build something useful. Prove it works. Put it back into the factory.**

A fight should leave people with software they want to use. They can try the
result, watch how BANTAM built it, and compare another agent on the same job.
Some of those results can become tools for BANTAM's next job.

## Four jobs worth watching

| The job | What people get | What BANTAM gets |
| --- | --- | --- |
| **“Make my project docs searchable.”** | A local docs search page and an MCP server that returns matching passages with source links. | A tool for finding the right project information. |
| **“Let my local agent use that tool.”** | An MCP bridge with a simple connection screen, available tools, and a working example. | Access to compatible MCP servers through its own action loop. |
| **“Make sure this bug never comes back.”** | A regression check built from a real bug report, with a visible failing example and the repaired result. | A reusable check for a failure the factory has encountered. |
| **“Let someone else use what we learned.”** | A shareable package containing the check, an example, instructions, and the fight that produced it. | A way to try another user's improvement on local work. |

Start with the docs tool. It has an obvious user benefit, a visible demo, and a
use outside BANTAM. Build it in three cards: working search, MCP access, then
repair stale results when documents change. Each card starts from its own frozen
starter, so a competitor can run it later without inheriting another agent's work.

The MCP bridge follows. Keep its protocol core independently testable, then use
a separate integration card to connect it to BANTAM. A successful standalone
library is only the first half of a working integration.

## Make the work easy to understand

Lead each public card with the request someone would actually type, a screenshot
or short demo, and the finished artifact. Use **Build**, **Extend**, and **Fix**
for the stages. Explain what changed in one sentence.

Offer three clear actions when their artifacts exist:

- **Try it** — a static demo or an exact local start command.
- **See the code** — the reviewed source for that particular result.
- **Watch the fight** — outcomes, elapsed time, and the complete recorded roster.

Show BANTAM's solo run first while developing the series. A missing demo or
unreviewed source package gets no working download button.

The current gallery publishes measurements and images. Runnable demos, source
releases, and installable improvements are additions proposed here.

## BANTAM first. Then the challengers.

Finish a complete BANTAM series with accepted work and clean completion on every
task. After a harness fix, rerun the affected task before selecting its new result
for the demo. In particular, ansi-wrap needs a fresh result after the September 8
checklist fixes; the code change alone is not a new passing run.

Freeze the selected runs, their harness revisions, work orders, starter files,
acceptance checks, model configurations, and budgets. Later challengers start
from those same task materials. Display their results beside the recorded BANTAM
attempts without rerunning or replacing those attempts merely to fill the board.

Make the comparison views obvious:

- **Same local model:** BANTAM, OpenCode, Hermes, and DeepSeek Harness.
- **Same Codex model:** native Codex and that model inside BANTAM.
- **Full card:** every recorded contender, with model labels visible.

Record the settings and run windows so the reader can see what each harness
brought to the job. This is a curated demonstration series developed through
BANTAM trials. Keep its earlier attempts accessible, and retain every challenger
outcome once the comparison starts. Do not silently change the task or its judge
after seeing a competitor's result.

## What earns a place in the toolbox?

Each job gets checks written from its user-visible requirements before the
scored attempt. For the docs tool, those include correct source references,
changed and deleted documents, empty results, and a working browser search.
For the bridge, they include tool discovery, argument validation, returned
errors, cancellation, and a real BANTAM turn using the result.

A reusable check must reject a known bad result and accept a correct one. Test
it on unfamiliar examples before calling it a general improvement. Then compare
fresh work with and without the tool, including its time and token overhead.
Building a tool and benefiting from it are two separate results to show.

Keep generated tools in a candidate workspace until they pass those checks.
Installation is an explicit, versioned step with a way back. Shared packages
carry their requirements, checks, source record, and compatibility information.
This is how a lesson becomes equipment another person can use.

## MCP opens the door

BANTAM would act as an MCP host, using clients to connect to configured servers.
Start with one pinned local server and tool discovery/calls; expand transport and
server coverage after the first end-to-end card works. The protocol already
provides the connection model and server tool interfaces.
[Client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts) ·
[Server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)

Bring tools into BANTAM's existing action, permission, and recording path. Load
tool descriptions when relevant, preserve failures in the observation, and make
it visible which server was called. Connecting a server should give the user
an understandable new capability, such as “search my project docs.”

A later direction is the reverse connection: expose bounded BANTAM jobs through
an MCP server so another compatible agent can commission local work and inspect
the returned patch and checks. That is a separate product from consuming MCP
tools and deserves its own card.

The existing [machinery program](FACTORY-MACHINERY-PROGRAM.md),
[self-improvement workflow](SELF-IMPROVEMENT.md), and
[card exchange](FIGHT-CARD-EXCHANGE.md) supply foundations. General MCP access,
a plugin builder, and executable lesson sharing are proposed integrations.

**The promise to work toward: every useful build can leave the factory better equipped.**
