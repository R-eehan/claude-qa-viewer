---
name: session-qa-viewer
description: Generate an interactive HTML visualization of all Claude Code Q&A sessions across projects. Use when you want to review past AskUserQuestion interactions, reflect on decisions, or export Q&A history.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

# Session Q&A Viewer

Run the visualization script to generate an interactive HTML dashboard of all your Claude Code Q&A sessions:

```bash
node ~/.claude/skills/session-qa-viewer/scripts/visualize-qa.js
```

The script will:
1. Scan `~/.claude/projects/` for all session JSONL files across every project
2. Extract Q&A interactions (AskUserQuestion tool calls and your responses)
3. Build a timeline with conversation context around each Q&A
4. Generate a single self-contained HTML file
5. Open it in the default browser

No arguments needed. It automatically discovers all sessions across all projects.
