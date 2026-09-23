# 1. 목표
session-sync 범용 도구 도약을 위한 필수 과제(Git Hook 전역 실행 경로 단절 버그 수정, Git Worktree 호환성 확보, 전역 설정 3단계 계층화) 해결 및 완전한 범용 스킬 전환.

# 2. 현재 상태
- 베이스 커밋: `816dca8` (또는 최신 커밋 HEAD)
- 구현 완료된 핵심 모듈:
  - `bin/session-sync.js`: init (2-Tier DB), push, fetch (--diff), hook (install/exec), ci, export 라우터
  - `lib/notion-client.js`: Projects DB 스키마 생성 및 Relation 양방향 연결, 100블록 배치 전송
  - `lib/project-metadata.js`: 토큰 절감형 정밀 슬라이싱 기반 메타데이터 추출 및 `.session-sync.json` 캐싱
  - `lib/local-cache.js`: `.sync_cache/pending/` FIFO 큐 및 Fail-Open 오프라인 보관소
  - `lib/git-hook.js`: pre-push 훅 설치 및 가드레일/Fail-Open 실행기
  - `lib/ci-runner.js`: 테스트 자식 프로세스 구동, stdout 기반 Pass/Fail 집계 및 Notion 자동 푸시
  - `lib/diff-engine.js`: 7대 섹션 의미론적 델타 연산기 및 파일 복원 시 7섹션 무결성 완전체 조립
  - `lib/exporter.js`: `.session-memory/archives/` 덤프 및 `.gitignore` 자동 등록
  - `lib/sync-engine.js`: Pending 큐 자동 플러시(Flush), 2-Tier 프로젝트 Relation 바인딩, 델타 페치 파이프라인 통합

# 3. 실행 명령
- 런타임 요구사항: Node.js v20.x 이상 (Windows PowerShell)
- 필수 환경변수:
  - `NOTION_API_KEY`: Notion 내부 인테그레이션 시크릿 토큰
  - `NOTION_DATABASE_ID`: 대상 Notion Session Memory Database ID
  - `NOTION_PROJECTS_DATABASE_ID`: 대상 Notion Projects Registry Database ID
- 12개 테스트 스위트 검증 및 CLI 실행 명령어:
```powershell
# 1. 12개 단위 및 통합 테스트 스위트 전체 실행
npm test

# 2. Git pre-push 훅 설치 상태 점검
node bin/session-sync.js hook install

# 3. 델타 페치 및 세션 조회
node bin/session-sync.js fetch --list
```

# 4. 통과 검사
- `tests/test-cli-routing.js`: CLI 인자 및 도움말 출력 (T01)
- `tests/test-parser.js`: 7칸 필수 섹션 및 가드레일 7종 검증 (T02, T03, 모호성 차단)
- `tests/test-transformer.js`: 2,000자 블록 청크 자동 분할 (T04)
- `tests/test-secret-scanner.js`: Gitleaks 정규식 기반 시크릿 차단 및 Allowlist 오탐 방지 (T05-C38)
- `tests/test-cache.js`: 오프라인 로컬 캐시 스냅샷 검증 (T08)
- `tests/test-notion-client.js`: 토큰 누락 차단 및 429 지수 백오프, 100블록 분할 (T05, T07)
- `tests/test-e2e-sync.js`: Mock 서버 기반 push/fetch E2E 파이프라인 (T06, T09, T10)
- `tests/test-project-metadata.js`: 기술 스택 및 README 요약 추출, `.session-sync.json` 캐시 무결성 검증
- `tests/test-pending-queue.js`: Pending 디렉토리 FIFO 큐 적재 및 completed 이동 검증
- `tests/test-git-hook.js`: pre-push 훅 설치, 백업 및 인수인계 파일 부재 시 skip 검증
- `tests/test-diff-engine.js`: 7섹션 H1 분리, 가변 섹션 분리 연산, 델타 요약 렌더링, 완전체 복원 검증
- `tests/test-exporter.js`: `.gitignore` 자동 등록 멱등성 및 타임스탬프 마크다운 아카이브 내보내기 검증
- 종합: 총 12개 테스트 스위트 100% 통과 (Green State)

# 5. 남은 문제
- `lib/git-hook.js`의 `HOOK_TEMPLATE`이 `node ./bin/session-sync.js` 상대 경로를 호출하여 타 프로젝트 루트에서 push 시 `MODULE_NOT_FOUND` 크래시 발생.
- `path.join(rootDir, '.git', 'hooks')` 디렉토리 가정으로 인해 Git Worktree 환경(`.git`이 파일인 경우)에서 `ENOTDIR` 예외 발생.
- 전역 설정 파일(`~/.session-sync/config.json`) 부재로 프로젝트마다 `.env`를 수동 복사해야 하는 운영 오버헤드 존재.

# 6. 다음 행동
- 대상 작업 디렉토리: `c:/work/aleph-05-memory`
- 수정 대상 파일:
  - `lib/git-hook.js`: `git rev-parse --git-path hooks` 명령을 통한 동적 훅 디렉토리 추출 및 `session-sync hook exec` 전역 실행식으로 템플릿 변경
  - `bin/session-sync.js`: `process.env` ➔ 로컬 `.env` ➔ OS 홈 디렉토리 `~/.session-sync/config.json` 3단계 캐스케이딩 로더 구현
  - `tests/test-git-hook.js`: Git Worktree 모의 환경 및 전역 바이너리 호출 템플릿 검증 테스트 추가
- 실행 순서:
  - 1단계: `lib/git-hook.js` 훅 탐색 시스템 콜 및 템플릿 전역화
  - 2단계: `bin/session-sync.js` 전역 캐스케이딩 설정 로더 구현
  - 3단계: 전체 12개 테스트 스위트 회귀 검증 및 신규 테스트 통과 확인

# 7. 건드리지 말 것
- `lib/markdown-parser.js`의 7대 필수 가드레일 정규식 완화 금지.
- `lib/block-transformer.js`의 `MAX_NOTION_TEXT_LENGTH = 2000` 상한선 변경 금지.
- `lib/secret-scanner.js`의 Gitleaks 정규식 및 저작권 라이선스 헤더 삭제 금지.
- `lib/diff-engine.js`의 `reconstructFullMarkdown` 7섹션 복원 무결성 해제 금지.
- `C:/Users/User/.gemini/config/harness/pre_tool_use.py`의 `.env` 파일 차단 로직 삭제 금지.
