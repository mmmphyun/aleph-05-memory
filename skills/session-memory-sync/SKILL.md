---
name: session-memory-sync
description: >
  Synchronize and restore structured 7-section handovers, Git state, and architectural decisions to Notion Database across multiple agent sessions.
  Enforces zero-context self-sufficiency with explicit runtime, file paths, and environment specifications.
---

# Notion Session Memory Sync Protocol (`session-sync`)

Use this skill to persist session states and seamlessly resume workflows across completely disconnected AI sessions (A ➔ B) using Notion Database as an external long-term memory engine.

---

## 1. Prerequisites & Execution Environment

The target workspace must meet the following baseline requirements:
- **Runtime**: Node.js v20.x or higher
- **CLI Availability**: `session-sync` (globally linked via `npm link`) or direct fallback invocation via `node "C:/work/aleph-05-memory/bin/session-sync.js"`.
- **Environment Variables**: Must be present in `.env` or injected via shell:
  - `NOTION_API_KEY`: Notion Internal Integration Secret
  - `NOTION_PARENT_PAGE_ID`: Target root Notion Page ID or URL
  - `NOTION_DATABASE_ID`: Generated Notion Database ID

---

## 2. Core Operational Workflow

### Phase 1: Context Restoration (At Session Start)
When starting a new conversation or resuming work from a prior session:

1. **Query session metadata (Leaf index, low token consumption)**:
   ```powershell
   session-sync fetch --list
   ```
2. **Restore the latest handover markdown**:
   ```powershell
   session-sync fetch --latest --out HANDOVER.md
   ```
3. Read `HANDOVER.md` thoroughly before making changes. Strictly comply with:
   - `[Execution Command]`: Use the exact commands to reproduce the environment.
   - `[Next Actions]`: Execute the planned next steps on the exact file paths listed.
   - `[Prohibited Scope]`: Never alter or break the designated constraint boundaries.

---

### Phase 2: In-Session Implementation
- Follow the 1-Task 1-Commit principle.
- Run tests regularly to ensure the codebase remains in a Green State.
- Do not modify files designated in `[Prohibited Scope]`.

---

### Phase 3: Session Persist & Handover (At Session End)
Before ending the session or handing over to another agent, you MUST construct `HANDOVER.md` with **concrete engineering facts**. Vague or abstract summaries are strictly blocked by the CLI parser.

#### Mandatory 7-Section Handover Template:

```markdown
# 1. 목표
- Concise summary of the business goal and specific functional requirement implemented.

# 2. 현재 상태
- Base commit SHA-1 (40 characters)
- Core modified files and symbols
- Architectural decisions (ADRs) and rationale

# 3. 실행 명령
- Runtime requirements (e.g. Node.js v20+, Python 3.11+)
- Required environment variables (`NOTION_API_KEY`, etc.)
- Reproducible verification commands in a code block:
```powershell
npm test
session-sync fetch --list
```

# 4. 통과 검사
- Concrete test suite IDs and verification command output proving Green State.

# 5. 남은 문제
- Known issues, pending test cases, or exact error logs/reasons.

# 6. 다음 행동
- Target file path: Must specify concrete relative path (e.g. `scripts/collect.js`, `src/handler.py`).
- Target function/symbol: The exact entrypoint to be modified.
- Data input/output interface specification.

# 7. 건드리지 말 것
- Explicitly list forbidden file paths, symbols, or compatibility constraints enclosed in backticks (e.g. `lib/markdown-parser.js`, `bin/session-sync.js`).
```

4. **Commit all local modifications**:
   ```powershell
   git commit -m "<type>(<scope>): <summary>"
   ```
5. **Dispatch to Notion DB**:
   ```powershell
   session-sync push --file HANDOVER.md --phase A_END --pass <P> --fail <F> --tags "tag1,tag2"
   ```

---

## 3. Anti-Bypass Guardrail Enforcement

The CLI parser strictly validates incoming handovers against 7 physical rules:
1. **Evasion Detection**: Single-word placeholders (`TODO`, `TBD`, `N/A`, `none`, `생략`) trigger immediate rejection (`exit code 1`).
2. **Minimum Content Length**: Each section must contain at least 15 characters of substantive technical detail.
3. **Executable Code Block**: Section `실행 명령` must contain at least one code block (``` ... ```).
4. **Runtime/Environment Declaration**: Section `실행 명령` must explicitly mention required runtime or environment variables (`node`, `npm`, `env`, etc.).
5. **Concrete File Path Mandate**: Section `다음 행동` must explicitly contain relative file paths with valid extensions (`.js`, `.py`, `.json`, etc.).
6. **Explicit Scope Demarcation**: Section `건드리지 말 것` must name specific files, symbols, or paths with backticks or extensions.
7. **2,000-Char Auto Chunking**: Long logs or stack traces exceeding 2,000 characters are automatically split into compliant Notion text blocks.
