---
name: session-memory-sync
description: Notion Database를 영구 메모리로 사용하여 세션 간 7칸 인수인계서, Git 상태, 아키텍처 결정을 동기화 및 복원하는 에이전트 스킬.
---

# Notion Session Memory Sync Skill (`session-sync`)

이 스킬은 여러 AI 세션(A ➔ B)이 교체되거나 대화 컨텍스트가 초기화되어도, Notion DB를 외부 장기 메모리로 활용하여 끊김 없이 작업을 인계받고 재개할 수 있도록 설계된 도구 규격입니다.

---

## 1. 사전 준비 (Environment Setup)

저장소 루트에 `.env` 파일을 생성하고 Notion 토큰과 부모 페이지를 설정합니다:

```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 2. 3대 핵심 프로토콜

### 1단계: 세션 시작 시 컨텍스트 복원 (Restoration)
새 대화 세션이 시작되면, 직전 세션의 상태와 인수인계 문서를 먼저 인출하여 환경을 복원합니다.

```powershell
# 1. 전체 세션 히스토리 목록 확인 (Leaf 속성 경량 조회: 토큰 극소량 소모)
node ./bin/session-sync.js fetch --list

# 2. 직전 세션의 7칸 인수인계 본문 복원
node ./bin/session-sync.js fetch --latest --out HANDOVER.md
```

- 복원된 `HANDOVER.md`의 `[실행 명령]`, `[다음 행동]`, `[건드리지 말 것]`을 확인하고 작업을 재개합니다.

---

### 2단계: 개발 중 결정 사항 및 상태 기록 (In-Session)
- 작업 중단 시점의 파일 수정 및 테스트 실행 상태를 엄밀히 유지합니다.
- 코드를 변경하기 전 반드시 `HANDOVER.md`의 `[건드리지 말 것]`에 기재된 아키텍처 제약 조건을 준수합니다.

---

### 3단계: 세션 종료 또는 작업 인계 시 동기화 (Persist & Handover)
세션을 끝내거나 다음 AI로 넘길 때는 4중 물리적 가드레일을 통과해야만 저장이 완료됩니다.

1. `HANDOVER.md` 작성 (아래 7대 필수 섹션 누락 시 파서 차단):
   - `# 1. 목표`
   - `# 2. 현재 상태`
   - `# 3. 실행 명령`
   - `# 4. 통과 검사`
   - `# 5. 남은 문제`
   - `# 6. 다음 행동`
   - `# 7. 건드리지 말 것`
2. Git 로컬 커밋 생성:
   ```powershell
   git add <수정파일>
   git commit -m "<type>(<scope>): <작업 요약>"
   ```
3. Notion DB로 세션 동기화 전송:
   ```powershell
   node ./bin/session-sync.js push --file HANDOVER.md --phase A_END --pass 5 --fail 5
   ```
   - 네트워크 단절 시 자동으로 `--fallback-cache` 모드가 작동하여 `.sync_cache/`에 영구 보존됩니다.

---

## 3. 에이전트 우회 차단 가드레일 규칙 (Guardrails)

- **금지 플레이스홀더 차단**: 본문에 `TODO`, `TBD`, `N/A`, `없음`, `추후 작성` 단독 기재 시 즉시 거부(`exit 1`).
- **최소 실질 길이 검증**: 각 섹션당 공백 제외 최소 15자 이상의 구체적 기술 필수.
- **2,000자 자동 분할**: 장문의 로그나 스택 트레이스는 2,000자 블록 단위로 자동 청크 분할되어 Notion API 에러 차단.
- **Git Ground Truth**: 커밋 해시와 저장소 이름은 CLI가 OS 시스템 콜로 직접 추출하여 메타데이터에 기록.
