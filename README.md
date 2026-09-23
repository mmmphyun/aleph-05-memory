# session-sync: 멀티 AI 세션 메모리 및 노션 동기화 엔진

여러 LLM 세션(A ➔ B)이 교체되거나 대화 컨텍스트가 초기화되어도, Notion Database를 외부 지속성 메모리로 활용하여 작업 인수인계(7항목 규격)와 프로젝트 상태를 온전히 이어받을 수 있도록 지원하는 무의존성(Zero-dependency) Node.js CLI 도구입니다.

---

## 주요 기능 및 아키텍처

1. **7칸 인수인계 무결성 가드레일 (`lib/markdown-parser.js`)**:
   - `목표`, `현재 상태`, `실행 명령`, `통과 검사`, `남은 문제`, `다음 행동`, `건드리지 말 것` 필수 7개 섹션 전수 검증.
   - `TODO`, `N/A`, `없음` 등 에이전트의 회피성 플레이스홀더 단독 기재 시 즉시 하드 차단(`exit 1`).
2. **2-Tier 시각적 대시보드 프로비저닝 (`Projects DB ↔ Session Memory DB`)**:
   - `Projects DB`에서 전체 저장소 현황, 기술 스택, 저장소 URL, 마지막 세션 시각을 시각적으로 조망.
   - `Session Memory DB`는 개별 세션 인수인계서를 기록하고 Relation 프로퍼티로 프로젝트에 양방향 매핑.
   - `.session-sync.json` 로컬 캐시를 병행하여 Notion API 추가 조회 비용을 0회로 단축.
3. **토큰 절감형 마크다운 델타 연산기 (`lib/diff-engine.js`)**:
   - 직전 세션 대비 변경된 섹션만 추출하여 LLM 프롬프트 토큰 소모를 최소화(`fetch --diff`).
   - 로컬 파일(`HANDOVER.md`) 복원 시에는 항상 7개 섹션 완전체를 유지하여 가드레일 무결성 보존.
4. **Git Pre-Push Hook 및 Fail-Open 내결함성 (`lib/git-hook.js`, `lib/local-cache.js`)**:
   - `git push` 시 자동으로 인수인계서 가드레일을 검증.
   - 오프라인 또는 Notion 장애 발생 시 `.sync_cache/pending/` 큐에 안전 보관 후 push 정상 통과(Fail-Open), 네트워크 복구 시 자동 재전송(Flush).
5. **CI 환경 파이프라인 자동화 (`lib/ci-runner.js`)**:
   - 자식 프로세스로 테스트를 직접 구동하고 stdout 파싱을 통해 Pass/Fail을 자동 집계하여 Notion DB로 푸시.
6. **오프라인 마크다운 히스토리 아카이브 (`lib/exporter.js`)**:
   - `.session-memory/archives/` 경로에 타임스탬프 기반 마크다운 스냅샷을 영구 보관하고 `.gitignore`에 자동 등록.
7. **순수 Node.js 내장 모듈 (Zero-Dependency)**:
   - 외부 npm 패키지 의존 없이 `node:https`, `node:fs`, `node:child_process`, `node:crypto` 표준 라이브러리만으로 동작.

---

## 빠른 시작 (Quick Start)

### 1. 환경 변수 설정 (`.env`)
```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PROJECTS_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. 전체 단위 및 통합 테스트 실행 (12개 스위트)
```powershell
npm test
```

### 3. CLI 명령어 사용법

```powershell
# 도움말 확인
session-sync --help

# 1. 빈 Notion 페이지에 2-Tier Projects & Session DB 스키마 구축
session-sync init --parent <NOTION_PAGE_ID>

# 2. 작업 인수인계서 검증 및 Notion/캐시 적재
session-sync push --file ./HANDOVER.md --phase A_END --pass 10 --fail 0

# 3. 과거 세션 목록 경량 조회 (Leaf 속성)
session-sync fetch --list

# 4. 직전 세션 인수인계 본문 복원 및 델타 확인
session-sync fetch --latest --out ./HANDOVER.md
session-sync fetch --diff

# 5. Git pre-push 훅 설치 및 실행
session-sync hook install
session-sync hook exec

# 6. CI 테스트 실행 및 자동 동기화
session-sync ci --test-cmd "npm test"

# 7. 세션 마크다운 로컬 아카이브 덤프
session-sync export --file ./HANDOVER.md
session-sync export --list
```
