# session-sync: Multi-Agent Session Memory & Notion Sync Engine

Zero-dependency Node.js CLI & Agent Skill for resilient session handovers across LLMs using Notion Database.

## Features
- **7-Section Handover Guardrails**: Strict validation against evasion placeholders (`TODO`, `N/A`, etc.).
- **Leaf-Parent 2-Tier Architecture**: Lightweight metadata indexing (`--list`) to prevent token explosion.
- **2000-Char Chunking**: Automatic block chunking compliant with Notion REST API limits.
- **Offline Resilient Fallback**: Automatic local caching in `.sync_cache/` on network failure.
- **Zero-Dependency**: Built purely on Node.js built-in modules (`node:https`, `node:fs`, `node:child_process`).

## Quick Start
```powershell
# Run all automated tests
npm test

# Check CLI usage
node ./bin/session-sync.js --help

# Dry-run handover push
node ./bin/session-sync.js push --file tests/fixtures/valid-handover.md --dry-run
```
