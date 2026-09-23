# 1. 목표
세션 간 7칸 인수인계서, Git 상태, 아키텍처 결정을 Notion DB에 영구 동기화하는 Zero-dependency Node.js CLI (session-sync) 모듈의 범용 도구화 확장 (Project Registry DB, Git Hooks/CI, 토큰 절감형 델타 페치, 오프라인 아카이브) 및 신규 세션 전환 준비.

# 2. 현재 상태
- 베이스 커밋: `7f3eb8a`
- 핵심 컴포넌트:
  - `bin/session-sync.js`: init, push, fetch 서브커맨드 라우터 및 .env 동적 로더
  - `lib/markdown-parser.js`: 7중 물리적 가드레일 (회피 차단, 코드블록, 런타임/환경변수, 파일 경로 필수 검증)
  - `lib/block-transformer.js`: 마크다운 ➔ Notion Block 2,000자 자동 청크 분할 및 역직렬화
  - `lib/notion-client.js`: node:https 기반 429 Retry-After 지수 백오프 및 100블록 배치 전송 클라이언트
  - `lib/local-cache.js`: 네트워크 장애 시 .sync_cache/ 자동 폴백
  - `lib/sync-engine.js`: Git 메타데이터(커밋 해시, 프로젝트명) OS 시스템 콜 자동 바인딩 및 프로젝트 격리 필터
  - `lib/secret-scanner.js`: Gitleaks 정규식 기반 시크릿 누출 스캐너 및 오탐 방지 Allowlist
- 전역 보안 가드레일:
  - `C:/Users/User/.gemini/config/harness/pre_tool_use.py`에 에이전트의 `.env` 직접 열람 및 CLI 덤프 차단 훅 구축 완료.

# 3. 실행 명령
- 런타임 요구사항: Node.js v20.x 이상 (Windows PowerShell)
- 사전 필수 환경변수:
  - `NOTION_API_KEY`: Notion 내부 인테그레이션 시크릿 토큰
  - `NOTION_DATABASE_ID`: 대상 Notion Database ID (3e404d37-c225-8139-8d33-e89fad623b0f)
- 글로벌 CLI 링크 확인 및 테스트 실행 명령어:
```powershell
# 1. aleph-05-memory 전역 링크 설정 (미설치 시)
npm link

# 2. 7개 테스트 스위트 전체 검증
npm test

# 3. Notion DB 동기화 검증
session-sync fetch --list
```

# 4. 통과 검사
- `tests/test-cli-routing.js`: CLI 인자 및 도움말 출력 (T01)
- `tests/test-parser.js`: 7칸 필수 섹션 및 가드레일 7종 검증 (T02, T03, 모호성 차단)
- `tests/test-transformer.js`: 2,000자 블록 청크 자동 분할 (T04)
- `tests/test-cache.js`: 오프라인 로컬 캐시 스냅샷 (T08 대비)
- `tests/test-notion-client.js`: 토큰 누락 차단 및 429 지수 백오프, 100블록 분할 (T05, T07)
- `tests/test-e2e-sync.js`: Mock 서버 기반 push/fetch E2E 파이프라인 (T06, T09, T10)
- `tests/test-secret-scanner.js`: Gitleaks 정규식 기반 시크릿 차단 및 Allowlist 오탐 방지 (T05-C38)

# 5. 남은 문제
- 단일 Database 구조로 인한 프로젝트별 메타데이터(README 요약, 기술 스택, 저장소 URL) 관리 부재 및 다중 프로젝트 조망 한계.
- 수동 `push` 의존성(Git hook 미연동)으로 인한 인수인계 누락 가능성.
- 인수인계 누적 시 전체 마크다운을 반복 수신하여 발생하는 프롬프트 토큰 낭비 문제.
- Notion 서비스 장애 시 로컬 마크다운 히스토리 아카이브 미구축.

# 6. 다음 행동
- 대상 작업 디렉토리: `c:/work/aleph-05-memory`
- 수정 대상 파일:
  - `lib/notion-client.js`: Project Registry DB 생성 및 2-Tier Relation 프로비저닝 로직 추가
  - `bin/session-sync.js`: `hook`, `ci`, `export`, `fetch --diff` 서브커맨드 라우팅 추가
  - `lib/sync-engine.js`: Git pre-push 훅 설치기 및 토큰 절감형 델타 추출 로직 구현
  - `lib/git-hook.js` [NEW]: Git pre-push 훅 템플릿 및 자동 설치 모듈 신규 구현
  - `lib/diff-engine.js` [NEW]: 직전 세션 대비 변경된 섹션만 추출하는 마크다운 델타 연산기 신규 구현
  - `lib/exporter.js` [NEW]: Notion 페이지 데이터를 로컬 마크다운 아카이브(`.session-memory/archives/`)로 영속화하는 내보내기 모듈 신규 구현
- 구현 순서:
  - 1단계: `lib/notion-client.js` 및 `bin/session-sync.js`에 Project Registry DB 생성 및 Relation 연동 구현
  - 2단계: `lib/git-hook.js` [NEW] 신규 작성하여 `.git/hooks/pre-push` 설치 및 실행 스크립트 장착
  - 3단계: `lib/diff-engine.js` [NEW] 신규 작성하여 직전 세션 대비 가변 섹션만 추출하는 델타 페치 구현
  - 4단계: `lib/exporter.js` [NEW] 신규 작성하여 로컬 `.session-memory/archives/` 백업 구현

# 7. 건드리지 말 것
- `lib/markdown-parser.js`의 7대 필수 가드레일 정규식 완화 금지.
- `lib/block-transformer.js`의 `MAX_NOTION_TEXT_LENGTH = 2000` 상한선 변경 금지.
- `lib/secret-scanner.js`의 Gitleaks 정규식 및 저작권 라이선스 헤더 삭제 금지.
- `C:/Users/User/.gemini/config/harness/pre_tool_use.py`의 `.env` 파일 차단 로직 삭제 금지.
