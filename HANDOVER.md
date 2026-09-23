# 1. 목표

session-sync 범용 도구 도약을 위한 3대 핵심 과제(Git Hook 전역 바이너리 호출 전환, Git Worktree 동적 훅 경로 탐색 및 Git 부재 시 로컬 백업, CLI init 로컬 환경변수 가이드 전환) 구현 및 12개 테스트 스위트 완전 검증.

# 2. 현재 상태

- 베이스 커밋: `b00e2510c8de6713c405a6f1e93d33aa85f527e1`
- 수정 완료된 핵심 모듈 및 심볼:
  - `lib/git-hook.js`: `resolveGitHooksDir(rootDir)` 동적 경로 추출 함수 추가, `HOOK_TEMPLATE`을 `session-sync hook exec "$@"`로 전환, Git 부재 시 `.session-memory/hooks/pre-push` 로컬 백업 폴백 처리.
  - `bin/session-sync.js`: `init` 명령어 시 `.env` 임의 덮어쓰기를 배제하고 터미널 환경변수 블록 가이드 출력 (`--write-env` 플래그 명시 시에만 자동 파일 갱신).
  - `tests/test-git-hook.js`: `git init` 및 `git worktree add` 시스템 콜 기반 Worktree E2E 검증, 템플릿 바이너리 검증, Git 부재 디렉토리 로컬 백업 검증 추가.
- 아키텍처 결정 사항 (ADR):
  - 전역 `~/.session-sync/config.json` 자동 기록은 프로젝트 간 DB ID 교차 오염 위험으로 인해 완전 배제하고, 프로젝트 로컬 `.env` 격리 정책 유지.
  - `git rev-parse --show-toplevel`을 통한 부모 레포지토리 블리드 방지 및 Worktree 내부 `gitdir: <path>` 파싱 지원.

# 3. 실행 명령

- 런타임 요구사항: Node.js v20.x 이상 (Windows PowerShell)
- 필수 환경변수: `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `NOTION_PROJECTS_DATABASE_ID` (로컬 `.env`에 정의)
- 검증 및 회귀 테스트 실행 명령어:
```powershell
# 1. Git Hook 및 Worktree E2E 단위 테스트 실행
node tests/test-git-hook.js

# 2. 전체 12개 단위 및 통합 테스트 스위트 회귀 검증
npm test

# 3. CLI init 도움말 옵션 확인
node bin/session-sync.js init --help
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
- 종합: 총 12개 테스트 스위트 100% Green State 유지 확인

# 5. 남은 문제

- `lib/git-hook.js`의 `HOOK_TEMPLATE`이 글로벌 바이너리(`session-sync`)를 호출하므로, `npm link` 또는 전역 설치(`npm install -g`)가 완료되지 않은 머신 환경에서는 `command not found`가 발생할 수 있음 (사용자 가이드 및 온보딩 문서화 필요).
- 대규모 저장소에서 워크트리 다중 생성 시 공통 훅 디렉토리 백업(`pre-push.bak`) 파일 충돌 여부에 대한 장기 모니터링 필요.

# 6. 다음 행동

- 대상 작업 디렉토리: `c:/work/aleph-05-memory`
- 수정 대상 파일:
  - `README.md`: `npm link` 필수 안내 및 `session-sync init [--write-env]` 옵션 사용법 추가
  - `package.json`: 바이너리 실행 권한 및 전역 배포 메타데이터 점검
- 실행 순서:
  - 1단계: `README.md`에 범용 CLI 글로벌 링크 설정 가이드 작성
  - 2단계: 신규 커밋 생성 및 Notion 세션 동기화 (`session-sync push`) 수행

# 7. 건드리지 말 것

- `lib/markdown-parser.js`의 7대 필수 가드레일 정규식 완화 금지.
- `lib/block-transformer.js`의 `MAX_NOTION_TEXT_LENGTH = 2000` 상한선 변경 금지.
- `lib/secret-scanner.js`의 Gitleaks 정규식 및 저작권 라이선스 헤더 삭제 금지.
- `lib/diff-engine.js`의 `reconstructFullMarkdown` 7섹션 복원 무결성 해제 금지.
- `C:/Users/User/.gemini/config/harness/pre_tool_use.py`의 `.env` 파일 차단 로직 삭제 금지.