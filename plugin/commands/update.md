---
description: Check for a new cco version and offer to install it in the settings view
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cco.mjs" open --view settings --action update`

Reply with the line above only. Do not run any tools.
