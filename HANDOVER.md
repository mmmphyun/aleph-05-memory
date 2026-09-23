# 1. 목표
세션 간 7칸 인수인계서, Git 상태, 아키텍처 결정을 Notion DB에 영구 동기화하는 Zero-dependency Node.js CLI (session-sync) 모듈 개발 및 과제 4(aleph-04-daily) 연동 준비.

# 2. 현재 상태
- 베이스 커밋: `c66c70f30` (Init부터 URL 자동 정제, .env 갱신, E2E 통합 테스트까지 완료)
- 핵심 컴포넌트:
  - `bin/session-sync.js`: init, push, fetch 서브커맨드 라우터 및 .env 동적 로더
  - `lib/markdown-parser.js`: 7중 물리적 가드레일 (회피 차단, 코드블록, 런타임/환경변수, 파일 경로 필수 검증)
  - `lib/block-transformer.js`: 마크다운 ➔ Notion Block 2,000자 자동 청크 분할 및 역직렬화
  - `lib/notion-client.js`: node:https 기반 429 Retry-After 지수 백오프 클라이언트
  - `lib/local-cache.js`: 네트워크 장애 시 .sync_cache/ 자동 폴백
  - `lib/sync-engine.js`: Git 메타데이터(커밋 해시, 프로젝트명) OS 시스템 콜 자동 바인딩
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

# 2. 단위 및 E2E 전체 테스트 10개 검증
npm test

# 3. Notion DB 목차 인덱스 조회
session-sync fetch --list
```

# 4. 통과 검사
- `tests/test-cli-routing.js`: CLI 인자 및 도움말 출력 (T01)
- `tests/test-parser.js`: 7칸 필수 섹션 및 가드레일 7종 검증 (T02, T03, 모호성 차단)
- `tests/test-transformer.js`: 2,000자 블록 청크 자동 분할 (T04)
- `tests/test-cache.js`: 오프라인 로컬 캐시 스냅샷 (T08 대비)
- `tests/test-notion-client.js`: 토큰 누락 차단 및 429 지수 백오프 (T05, T07)
- `tests/test-e2e-sync.js`: Mock 서버 기반 push/fetch E2E 파이프라인 (T06, T09, T10)

# 5. 남은 문제
과제 4 (`c:/work/aleph-04-daily`) 레포지토리의 일일 해커뉴스 크롤링 스크립트 실행 후 수집 데이터 및 세션 상태를 Notion DB로 자동 push하는 연동 로직 미구현.

# 6. 다음 행동
- 대상 작업 디렉토리: `c:/work/aleph-04-daily`
- 수정 대상 파일: `c:/work/aleph-04-daily/scripts/collect.js`
- 수정 위치: `fetchHackerNews()` 함수에서 최신 뉴스 JSON 수집 완료 및 `data/news.json` 저장 직후
- 구현 내용:
  - `data/news.json`의 상위 5개 인기 뉴스 타이틀과 포인트를 요약 본문으로 구성
  - `child_process.execSync`를 활용하여 `session-sync push --file ... --phase ...`를 호출하는 자동 동기화 트리거 연동

# 7. 건드리지 말 것
- `lib/markdown-parser.js`의 7대 필수 가드레일 정규식 완화 금지.
- `lib/block-transformer.js`의 `MAX_NOTION_TEXT_LENGTH = 2000` 상한선 변경 금지.
- `C:/Users/User/.gemini/config/harness/pre_tool_use.py`의 `.env` 파일 차단 로직 삭제 금지.
