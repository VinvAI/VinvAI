# goal

Standalone goal-authoring prompt renderer: distill an arbitrary working
context — task notes, a session summary, an issue description, trace
evidence — into **one crisp, actionable goal string**.

Harness-only: every command prints a fully rendered prompt (zero LLM calls).
Execute the printed prompt with your coding-agent harness (Claude Code,
Cursor, Windsurf, …); the harness replies with the JSON object the prompt
specifies.

## Usage

```bash
# Context as an argument
goal create "Payments intermittently 502 behind the LB; retries mask it; we need it gone before GA."

# Context from a file
goal create --context-file notes.md

# Context on stdin
some-command | goal create --context-file -
```

The printed prompt instructs the executing agent to reply with:

```json
{
  "goal": "Eliminate the intermittent 502s on the payment path before GA.",
  "reasoning": "…"
}
```

The episode loop's verification prompts ride the same CLI: `goal judge-diff`,
`goal author-tests`, and `goal judge-stall` each read one JSON payload from
`--payload-file` (`-` for stdin) and print the rendered prompt for the
harness; each prompt states the exact JSON object the reply must contain.

## Development

```bash
cd goal
uv sync --extra dev
uv run pytest
```
