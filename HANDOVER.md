# 1. 목표

session-sync 실무 사용성 및 개발자 경험 극대화를 위한 `scaffold`(인수인계 초안 자동 추출기) 및 `doctor`(환경 무결성 진단기) 서브커맨드 구현, 테스트 스위트 확장 및 타 저장소 E2E 검증 완료.

# 2. 현재 상태

- 베이스 커밋: `8a4581b40ffae6b0feedb6f2e7728a457f017098`
- 구현 완료 내역:
  - `lib/git-hook.js`: `git rev-parse --show-toplevel` 블리드 차단, Worktree 내부 `gitdir: <path>` 파싱을 통한 동적 훅 디렉토리 추출, Git 부재 시 `.session-memory/hooks/pre-push` 로컬 백업 폴백, 전역 바이너리 템플릿(`session-sync hook exec "$@"`) 전환 완료.
  - `bin/session-sync.js`: `init` 시 `.env` 임의 덮어쓰기 배제 및 터미널 환경변수 블록 가이드 출력 (`--write-env` 플래그 명시 시에만 자동 갱신).
  - `tests/test-git-hook.js`: 실제 `git init` 및 `git worktree add` 시스템 콜 기반 Worktree E2E 검증 및 로컬 백업 검증 통과.
- 종합 품질 상태: 12개 테스트 스위트 100% Green State 유지 중.

# 3. 실행 명령

- 런타임 요구사항: Node.js v20.x 이상 (Windows PowerShell)
- 필수 환경변수: `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `NOTION_PROJECTS_DATABASE_ID` (로컬 `.env`)
- 테스트 및 세션 검증 실행 명령어:
```powershell
# 1. Git Hook 및 Worktree E2E 단위 테스트 실행
node tests/test-git-hook.js

# 2. 전체 12개 단위 및 통합 테스트 스위트 회귀 검증
npm test

# 3. 최신 세션 목차 조회
node bin/session-sync.js fetch --list
```

# 4. 통과 검사

- `tests/test-cli-routing.js`: CLI 인자 및 도움말 출력 (T01) 통과
- `tests/test-parser.js`: 7칸 필수 섹션 및 가드레일 7종 검증 (T02, T03, 모호성 차단) 통과
- `tests/test-transformer.js`: 2,000자 블록 청크 자동 분할 (T04) 통과
- `tests/test-secret-scanner.js`: Gitleaks 정규식 기반 시크릿 차단 및 Allowlist 오탐 방지 (T05-C38) 통과
- `tests/test-cache.js`: 오프라인 로컬 캐시 스냅샷 검증 (T08) 통과
- `tests/test-notion-client.js`: 토큰 누락 차단 및 429 지수 백오프, 100블록 분할 (T05, T07) 통과
- `tests/test-e2e-sync.js`: Mock 서버 기반 push/fetch E2E 파이프라인 (T06, T09, T10) 통과
- `tests/test-project-metadata.js`: 기술 스택 및 README 요약 추출, `.session-sync.json` 캐시 무결성 통과
- `tests/test-pending-queue.js`: Pending 디렉토리 FIFO 큐 적재 및 completed 이동 검증 통과
- `tests/test-git-hook.js`: pre-push 훅 설치, 백업, Worktree E2E 및 Git 부재 로컬 백업 검증 통과
- `tests/test-diff-engine.js`: 7섹션 H1 분리, 가변 섹션 분리 연산, 델타 요약 렌더링, 완전체 복원 검증 통과
- `tests/test-exporter.js`: `.gitignore` 자동 등록 멱등성 및 타임스탬프 마크다운 아카이브 내보내기 검증 통과
- 종합: 총 12개 테스트 스위트 100% Green State 확인

# 5. 남은 문제

- 에이전트가 세션 종료 시 7대 섹션을 수동으로 처음부터 작성해야 하여 토큰 낭비 및 가드레일 오탈자 발생 위험 존재 (`scaffold` 미구현).
- 신규 저장소 적용 시 Node 런타임, `npm link`, PATH 등록, `.env` 키 유효성, Notion API 연결 상태를 한 번에 검증하는 진단 도구 부재 (`doctor` 미구현).

# 6. 다음 행동

- 대상 작업 디렉토리: `c:/work/aleph-05-memory`
- 신규 생성 및 수정 대상 파일:
  - `lib/scaffold.js`: `git status -s`, `git log -1`, `git diff --stat` 시스템 콜을 통해 최근 수정 파일과 커밋 해시를 수집하고 7대 섹션 초안을 생성하는 모듈 신규 구현.
  - `lib/doctor.js`: Node 버전, Git 설치 여부, `session-sync` 전역 바이너리 접근성, `.env` 3대 키 유효성, Notion API 통신 핑(Ping)을 점검하는 환경 진단 모듈 신규 구현.
  - `bin/session-sync.js`: `scaffold`, `doctor` 서브커맨드 라우터 및 도움말 추가.
  - `tests/test-scaffold.js`: 생성된 초안의 7대 가드레일 통과 여부 및 Git 메타데이터 주입 검증 테스트 신규 작성.
  - `tests/test-doctor.js`: 진단 항목별 통과/경고/실패 판정 검증 테스트 신규 작성.
- 실행 순서:
  - 1단계: `lib/scaffold.js` 및 `tests/test-scaffold.js` 구현
  - 2단계: `lib/doctor.js` 및 `tests/test-doctor.js` 구현
  - 3단계: `bin/session-sync.js` 라우팅 연동 및 `npm test` 회귀 검증

# 7. 건드리지 말 것

- `lib/markdown-parser.js`의 7대 필수 가드레일 정규식 완화 금지.
- `lib/block-transformer.js`의 `MAX_NOTION_TEXT_LENGTH = 2000` 상한선 변경 금지.
- `lib/secret-scanner.js`의 Gitleaks 정규식 및 저작권 라이선스 헤더 삭제 금지.
- `lib/diff-engine.js`의 `reconstructFullMarkdown` 7섹션 복원 무결성 해제 금지.
- `C:/Users/User/.gemini/config/harness/pre_tool_use.py`의 `.env` 파일 차단 로직 삭제 금지.