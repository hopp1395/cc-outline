---
description: Continue this session in another Claude account (optionally named by email or config folder) via the cco sessions view
argument-hint: "[email or config folder]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cco.mjs" open --view sessions --action account --select "$ARGUMENTS"`

Reply with the line above only. Do not run any tools.
