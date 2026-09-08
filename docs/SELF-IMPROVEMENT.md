# Improve the factory with the factory

BANTAM FACTORY can work on its own machinery. Completed jobs feed a local record of
recurring friction; the self-improvement workflow uses that evidence to choose
a weakness, build a candidate change, and test it.

**Use the factory. Find the friction. Build better equipment.**

## Try a cycle

From your BANTAM FACTORY source checkout:

```bash
# See candidate improvements without calling a model.
./bin/run-dev.sh self-improve --plan

# Build and test a candidate; keep the running source unchanged.
./bin/run-dev.sh self-improve --no-apply

# Run a cycle that can apply and promote an eligible improvement.
./bin/run-dev.sh self-improve
```

In an interactive session, use `:self-improve plan` or `:self-improve`.

## What happens?

1. **Find a weakness.** Start from the exact BANTAM FACTORY checkout and its evidence.
2. **Build a candidate.** Work in a separate copy with a bounded change scope.
3. **Test it.** Check the candidate and the protected baseline tests.
4. **Keep a proven improvement.** Eligible changes must demonstrate the required
   improvement before promotion. Failed deployment checks trigger rollback.

Review the outcome after a cycle. Restart BANTAM FACTORY after a successful promotion
to load the changed code. Keep edits to the BANTAM FACTORY checkout out of the deployment
window.

## What carries forward today?

The local observation store keeps bounded counters and task hashes. Normal work
can add evidence; applying a change requires the explicit cycle above.

This is an **experimental workflow**. Runtime observations can motivate a
candidate without proving it improves the original task. Those candidates stay
as tested development checkpoints until a paired behavioral check establishes
the missing improvement. Passing unit tests alone doesn't promote them.

You can also ask BANTAM FACTORY to build reusable tools for your own project. Turn a
recurring chore into a [fight card](BRING-YOUR-OWN-COMPARISONS.md), keep the useful
output, and test how much it helps on the next job.

**[The factory formula](FACTORY-MODEL.md) · [Build, inspect, apply](FACTORY-GETTING-STARTED.md) · [Docs](README.md)**
