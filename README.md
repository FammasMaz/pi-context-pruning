# pi-context-pruning

A [pi](https://github.com/badlogic/pi-mono) extension that proactively prunes old tool outputs from LLM context to reduce token usage.

Pruning algorithm ported from [OpenCode](https://github.com/sst/opencode).

## The Problem

Pi sends **all** tool outputs (file reads, bash output, grep results, etc.) to the LLM until the context window fills up and compaction triggers. This means:

- Long sessions accumulate massive context from stale tool outputs
- Token usage grows linearly until forced compaction
- You pay for tokens the LLM doesn't need (old file contents, superseded grep results)

OpenCode solves this by **proactively pruning old tool outputs after every turn**, keeping context lean. This extension brings that same strategy to pi.

## Install

```bash
# From local clone
pi install /path/to/pi-context-pruning

# Or from the repo directory
pi install .
```

After installing, `/reload` or restart pi.

## Enable / Disable

Enabled by default. Toggle via `settings.json` (global or project):

```jsonc
// ~/.pi/agent/settings.json (global) or .pi/settings.json (project)
{
  "contextPruning": {
    "enabled": false
  }
}
```

Project settings override global. Changes take effect on `/reload` or next session.

## How It Works

```
Before pruning (what pi normally sends):
┌────────┬──────┬───────┬──────┬───────┬──────┬───────┬──────┬───────┐
│ system │ user │ asst  │ tool │ user  │ asst │ tool  │ asst │ tool  │
│ prompt │  #1  │  #1   │ 50KB │  #2   │  #2  │ 30KB  │  #3  │ 10KB  │
└────────┴──────┴───────┴──────┴───────┴──────┴───────┴──────┴───────┘
                         ↑ stale, expensive

After pruning (what the LLM actually sees):
┌────────┬──────┬───────┬──────────────────┬──────┬───────┬──────┬───────┐
│ system │ user │ asst  │ [pruned ~12.5K   │ user │ asst  │ tool │ tool  │
│ prompt │  #1  │  #1   │  tokens | read]  │  #2  │  #2   │ 30KB │ 10KB  │
└────────┴──────┴───────┴──────────────────┴──────┴───────┴──────┴───────┘
                         ↑ tiny marker          recent context preserved ↑
```

### Algorithm (ported from OpenCode's `compaction.ts`)

Before each LLM call, via pi's `context` event:

1. **Walk messages backward** from newest
2. **Skip recent turns** — last 2 user turns are fully protected
3. **Stop at compaction boundary** — already-summarized content is untouched
4. **Accumulate tool output tokens** — first 40K tokens of older tool outputs are protected
5. **Beyond 40K** → replace tool output content with a short marker:
   ```
   [output pruned — ~12,500 tokens | read path="src/components/App.tsx"]
   ```
6. **Only prune if worthwhile** — minimum 20K tokens must be prunable

### Key Properties

- **Non-destructive**: Session file keeps full history. Only the LLM sees pruned content.
- **Preserves tool call metadata**: The LLM still knows which tools were called and with what arguments.
- **Complements compaction**: Runs alongside pi's built-in compaction — pruning reduces token usage *between* compactions.
- **Error outputs protected**: Tool results with `isError: true` are never pruned (diagnostics matter).
- **Re-readable**: If the LLM needs old file contents, it can re-read the file. The marker tells it what was there.

## Commands

| Command | Description |
|---------|-------------|
| `/prune` | Force prune now — bypasses minimum threshold, runs on next LLM call |
| `/prune-toggle` | Toggle pruning on/off for the current session |
| `/prune-stats` | Show pruning statistics for the current session |
| `/prune-config` | Show current pruning configuration |

### Status Bar

The footer shows live pruning status:
```
🔪 45.2K tool tokens scanned | pruned ~25.0K | 8 protected
```

## Configuration

Edit `extensions/context-pruning/config.ts` in the installed package:

| Constant | Default | Description |
|----------|---------|-------------|
| `PRUNE_MINIMUM` | `20,000` | Minimum prunable tokens before acting |
| `PRUNE_PROTECT` | `40,000` | Token budget for protected older tool outputs |
| `PROTECTED_TURNS` | `2` | Recent user turns to never prune |
| `PROTECTED_TOOLS` | `[]` | Tool names that are never pruned |
| `PRUNABLE_TOOLS` | `["read", "bash", "grep", "find", "ls", "edit", "write"]` | Tools eligible for pruning |

### Tuning Guide

- **More aggressive pruning**: Lower `PRUNE_PROTECT` (e.g., `20_000`) and/or `PRUNE_MINIMUM` (e.g., `10_000`)
- **Less aggressive**: Raise `PRUNE_PROTECT` (e.g., `80_000`) or increase `PROTECTED_TURNS`
- **Protect extension tools**: Add tool names to `PROTECTED_TOOLS`
- **Prune everything**: Set `PRUNABLE_TOOLS` to `[]` (empty = all non-protected tools are prunable)

## How This Differs From Pi's Built-in Compaction

| Feature | Pi Compaction | Context Pruning |
|---------|--------------|-----------------|
| **When** | Context exceeds threshold | Every LLM call |
| **What** | Summarizes old messages via LLM | Replaces old tool outputs with markers |
| **Cost** | Requires LLM call for summary | Zero — no LLM calls |
| **Persistence** | Modifies session (adds CompactionEntry) | Non-destructive (session unchanged) |
| **Granularity** | Entire conversation turns | Individual tool outputs |

They work together: pruning keeps context lean between compactions, so compaction triggers less often (or not at all for shorter sessions).

## Architecture

```
extensions/context-pruning/
├── index.ts      # Extension entry — context hook, commands, status
├── pruner.ts     # Pure pruning function (testable, no side effects)
└── config.ts     # Configuration constants, types, and settings loader
```

No dependencies — only uses `estimateTokens` from `@mariozechner/pi-coding-agent` (available at runtime via pi).

## Credits

Pruning algorithm ported from [OpenCode](https://github.com/sst/opencode). Thanks to the OpenCode team.

See also: [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
