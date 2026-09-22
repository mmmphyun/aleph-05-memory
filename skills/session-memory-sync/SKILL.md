---
name: session-memory-sync
description: Synchronize and restore structured 7-section handovers, Git state, and architectural decisions to Notion Database across multiple agent sessions.
---

# Notion Session Memory Sync Protocol (`session-sync`)

Use this skill to persist session states and seamlessly resume workflows across disconnected AI sessions (A ➔ B) using Notion Database as an external long-term memory engine.

---

## 1. Prerequisites

Ensure `.env` exists in the repository root with appropriate credentials:

```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 2. Core Operational Workflow

### Phase 1: Context Restoration (At Session Start)
When starting a new conversation or resuming work from a prior session:

1. **Query session metadata (Leaf index, low token consumption)**:
   ```powershell
   node ./bin/session-sync.js fetch --list
   ```
2. **Restore the latest handover markdown**:
   ```powershell
   node ./bin/session-sync.js fetch --latest --out HANDOVER.md
   ```
3. Read `HANDOVER.md` thoroughly before making changes. Strictly comply with:
   - `[Execution Command]`: Use the exact commands to reproduce the environment.
   - `[Next Actions]`: Execute the planned next steps.
   - `[Prohibited Scope]`: Never alter or break the designated constraint boundaries.

---

### Phase 2: In-Session Implementation
- Follow the 1-Task 1-Commit principle.
- Run tests regularly to ensure the codebase remains in a Green State.
- Do not modify files designated in `[Prohibited Scope]`.

---

### Phase 3: Session Persist & Handover (At Session End)
Before ending the session or handing over to another agent:

1. **Prepare `HANDOVER.md`** containing all 7 mandatory sections:
   - `# 1. 목표` (Goal)
   - `# 2. 현재 상태` (Current Status)
   - `# 3. 실행 명령` (Execution Commands)
   - `# 4. 통과 검사` (Passed Tests)
   - `# 5. 남은 문제` (Remaining Issues)
   - `# 6. 다음 행동` (Next Actions)
   - `# 7. 건드리지 말 것` (Prohibited Scope)
2. **Commit all local modifications**:
   ```powershell
   git commit -m "<type>(<scope>): <summary>"
   ```
3. **Dispatch to Notion DB**:
   ```powershell
   node ./bin/session-sync.js push --file HANDOVER.md --phase A_END --pass <P> --fail <F>
   ```

---

## 3. Anti-Bypass Guardrail Enforcement

The CLI parser strictly blocks non-compliant or evasive agent inputs:

- **Evasion Detection**: Single-word placeholders (`TODO`, `TBD`, `N/A`, `none`, `생략`) will trigger immediate rejection (`exit code 1`).
- **Minimum Content Length**: Each section must contain at least 15 characters of substantive technical detail.
- **Automatic Block Chunking**: Long logs or stack traces exceeding 2,000 characters are automatically split into compliant Notion text blocks.
- **Ground Truth Capture**: Git commit hash and repository metadata are captured directly via OS system calls, preventing fabricated state reporting.
