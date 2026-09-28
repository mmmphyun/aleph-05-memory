# session-sync: 멀티 AI 세션 메모리 및 노션 동기화 엔진

AI 세션이 끊기거나 대화 컨텍스트가 초기화되어도 Notion Database를 외부 영속 저장소로 활용하여 7개 섹션 인수인계 규격과 작업 불변식을 복원하는 CLI 도구입니다.

---

## 1. 주요 기능 및 아키텍처

```mermaid
flowchart LR
    A["Session A 작업 완료"] --> B["session-sync scaffold<br/>(작업트리 기반 초안)"]
    B --> C["7섹션 작성 & 검토<br/>(ADR 및 I/O 명시)"]
    C --> D["session-sync push<br/>(9대 가드레일 & 2천자 청킹)"]
    D --> E[("Notion 2-Tier DB<br/>Projects ↔ Sessions")]
    E --> F["session-sync fetch --latest --verify<br/>(불변식 검증 복원)"]
    F --> G["Session B 작업 재개"]
```

- **7섹션 인수인계 가드레일 (`lib/markdown-parser.js`)**:
  - `목표`, `현재 상태`, `실행 명령`, `통과 검사`, `남은 문제`, `다음 행동`, `건드리지 말 것` 필수 7개 섹션 전수 검증.
  - 회피성 단어(`TODO`, `N/A`, `없음`, `생략`) 단독 기재 차단, ADR(`[채택]`, `[이유]`, `[기각 대안]`) 및 인터페이스 I/O 규격 명시 강제.
- **2-Tier 노션 대시보드 (`Projects DB ↔ Session Memory DB`)**:
  - `Projects DB`에서 전체 저장소 현황, 기술 스택, 저장소 URL, 마지막 세션 시각을 시각적으로 조망.
  - `Session Memory DB`는 개별 세션 인수인계서를 기록하고 Relation 프로퍼티로 양방향 연결.
- **SWE-agent 기반 불변식 검증기 (`lib/verifier.js`)**:
  - 인수인계서에 명시된 베이스 커밋과 Git HEAD의 일치 여부(드리프트 탐지), 작업 트리 청결도, 실제 테스트 스위트 재현성 검증.
- **하이브리드 RRF 검색 엔진 (`lib/hybrid-search.js`, `lib/search-engine.js`)**:
  - Sparse 렉시컬(BM25)과 Dense 시맨틱(multilingual-e5 INT8) 검색 결과를 상호 순위 융합(Reciprocal Rank Fusion, k=60)으로 결합.
  - ADR Supersedes 묘비(Tombstone) 감점(-80%) 및 SQLite WAL 모드 임베딩 캐싱 적용.
- **내결함성 및 오프라인 Failover (`lib/sync-engine.js`, `lib/git-hook.js`)**:
  - Notion API 429 지수 백오프, 오프라인 시 로컬 큐(`pending/`) 적재(Fail-Open) 및 `.session-memory/archives/` 로컬 아카이브 Failover 복원.
- **전역 CLI 패키징 (`npm link`)**:
  - 심볼릭 링크를 통해 어떤 프로젝트 경로에서도 `session-sync` 단독 실행 지원.

---

## 2. 10대 보안 및 안티 바이패스 가드레일 규격

| 번호 | 규칙명 | 검증 기준 및 차단 사유 |
|:---:|:---|:---|
| 0 | 시크릿 차단 | Gitleaks 정규식 기반 API 키, 개인키, 토큰, JWT 평문 탐지 시 즉시 차단 (`exit 1`) |
| 1 | 회피 방지 | `TODO`, `TBD`, `N/A`, `none`, `생략` 단독 기재 시 즉시 거부 (`exit 1`) |
| 2 | 최소 분량 | 각 섹션마다 최소 15자 이상의 구체적 기술 내용 기재 필수 |
| 3 | 코드 블록 | `실행 명령` 섹션 내 실행 가능한 코드 블록(```) 1개 이상 포함 |
| 4 | 런타임 선언 | `실행 명령` 섹션에 런타임/환경변수(`node`, `npm`, `env` 등) 명시 필수 |
| 5 | 파일 경로 명시 | `다음 행동` 섹션에 대상 파일의 상대 경로 및 확장자(`.js`, `.json` 등) 명시 |
| 6 | 스코프 격리 | `건드리지 말 것` 섹션에 변경 금지 대상 파일/모듈명을 백틱 또는 경로로 명시 |
| 7 | 2천자 청킹 | Notion API 2,000자 블록 제한을 초과하는 로그/내용은 자동 분할 업로드 |
| 8 | ADR 명시 | `현재 상태` 섹션에 설계 의사결정 기록(`[채택]`, `[이유]`, `[기각 대안]`) 명시 |
| 9 | I/O 인터페이스 | `다음 행동` 섹션에 함수 시그니처, 파라미터 제약조건 또는 예외 정책 명시 |

---

## 3. 설치 및 환경 설정

### 3.1 전역 CLI 등록
```powershell
# 저장소 루트에서 전역 심볼릭 링크 등록
npm link

# 설치 확인
session-sync --version
```

### 3.2 환경 변수 설정 (`.env`)
대상 프로젝트 루트 경로에 `.env` 파일을 구성합니다:
```env
# Notion Internal Integration Secret Token (필수)
NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 상위 Notion 부모 페이지 URL 또는 ID (session-sync init 시 필수)
NOTION_PARENT_PAGE_ID=https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxx

# session-sync init 실행 시 자동 등록되는 데이터베이스 ID
NOTION_PROJECTS_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

## 4. CLI 명령어 레퍼런스

### 4.1 프로젝트 초기화 (`init`)
빈 Notion 부모 페이지 하위에 2-Tier Projects 및 Session Memory 데이터베이스를 자동 구축하고 `.env`를 갱신합니다.
- **멱등성 및 멀티 프로젝트 중앙 레지스트리 자동 재사용**:
  - 부모 페이지에 이미 2-Tier DB가 존재하는 경우 중복 생성하지 않고 기존 DB ID를 자동 탐색하여 바인딩합니다.
  - 이를 통해 여러 프로젝트가 동일한 부모 페이지를 공유하며 단일 중앙 레지스트리에 세션을 통합 관리할 수 있습니다.
  - 강제 신규 생성이 필요한 경우 `--force` 플래그를 사용합니다.
```powershell
# 기존 DB 자동 탐색 재사용 또는 최초 생성
session-sync init --parent <NOTION_PAGE_URL_OR_ID> --write-env

# 강제 신규 DB 생성 (필요 시)
session-sync init --parent <NOTION_PAGE_URL_OR_ID> --write-env --force
```

### 4.2 환경 무결성 진단 (`doctor`)
Node.js 런타임 버전, Git VCS, 전역 바이너리 도달성, 환경변수 유효성, Notion API 연결 상태를 전수 진단합니다.
```powershell
session-sync doctor
```

### 4.3 인수인계 초안 자동 생성 (`scaffold`)
현재 Git 커밋 해시, 변경 파일 목록, 런타임 환경 정보를 바탕으로 9대 가드레일을 충족하는 7섹션 마크다운 초안을 생성합니다.
```powershell
session-sync scaffold --out HANDOVER.md --force
```

### 4.4 세션 푸시 (`push`)
작성된 `HANDOVER.md`를 9대 가드레일로 검증한 뒤 2,000자 블록 단위로 변환하여 Notion DB 및 로컬 큐에 업로드합니다.
```powershell
session-sync push --file HANDOVER.md --phase A_END --pass 21 --fail 0 --tags "release,cli"
```

### 4.5 세션 인출 및 복원 (`fetch`)
Notion DB에서 세션 목록을 조회하거나, 최신 세션을 로컬 파일로 복원하며 작업 불변식을 즉시 검증합니다.
```powershell
# 세션 목차 목록 조회 (경량 Leaf 쿼리)
session-sync fetch --list

# 최신 세션 복원 및 작업 불변식 실측 검증 (--verify)
session-sync fetch --latest --out HANDOVER.md --verify

# 직전 세션 대비 변경된 가변 섹션만 인출 (프롬프트 토큰 절감)
session-sync fetch --diff

# Notion API 장애 또는 오프라인 시 로컬 아카이브에서 안전 복원
session-sync fetch --latest --out HANDOVER.md --failover-archive
```

### 4.6 불변식 검증 (`verify`)
인수인계서에 명시된 베이스 커밋과 실제 Git HEAD 일치 여부, 작업 트리 청결도, 실제 테스트 통과 여부를 진단합니다.
```powershell
# 빠른 상태 진단 (Git HEAD 일치 및 작업 트리 검사)
session-sync verify

# 테스트 스위트 실제 재현성 전수 검증
session-sync verify --run-test

# Git 커밋 불일치 발생 시 즉시 프로세스 실패(exit 1) 처리
session-sync verify --strict
```

### 4.7 하이브리드 RRF 검색 (`search`)
과거 세션 아카이브를 대상으로 렉시컬(BM25)과 시맨틱(multilingual-e5)을 결합하여 컨텍스트를 즉시 인출합니다.
```powershell
# 하이브리드 RRF 융합 검색 (기본 권장)
session-sync search --query "아카이브 복원" --mode hybrid

# 특정 섹션만 필터링 검색
session-sync search --query "HTTP 429 백오프" --section next

# BM25 단독 검색 (저사양 환경)
session-sync search --query "Scaffold" --mode bm25
```

### 4.8 Git Pre-Push 훅 관리 (`hook`)
`git push` 실행 시 자동으로 세션 상태를 검증하고 Notion DB에 동기화하는 Git 훅을 설치합니다.
```powershell
session-sync hook install
```

### 4.9 로컬 아카이브 영구 보관 (`export`)
세션 마크다운을 `.session-memory/archives/`에 타임스탬프 스냅샷으로 백업합니다 (`.gitignore` 자동 격리).
```powershell
session-sync export --file HANDOVER.md
session-sync export --list
```

---

## 5. 테스트 스위트 검증

21개 단위 및 통합 테스트 스위트로 전수 회귀 검증을 수행합니다:
```powershell
npm test
```
```
================================================================
  ALL TEST SUITES PASSED (GREEN STATE VERIFIED)
================================================================
```
검증 대상:
- `test-cli-routing`: CLI 인자 및 서브커맨드 라우팅 (9/9)
- `test-parser`: 7섹션 필수 분해 및 가드레일 무결성 (5/5)
- `test-transformer`: 2,000자 블록 분할 및 양방향 역직렬화 (3/3)
- `test-secret-scanner`: Gitleaks 정규식 기반 시크릿 차단 (4/4)
- `test-cache`: 로컬 JSON 스냅샷 저장 및 복원 (2/2)
- `test-notion-client`: HTTP 429 지수 백오프 (4/4)
- `test-e2e-sync`: Mock 서버 푸시/인출 및 아카이브 Failover (9/9)
- `test-project-metadata`: 기술 스택 및 README 요약 추출 (3/3)
- `test-pending-queue`: FIFO 큐 적재 및 completed 이동 (3/3)
- `test-git-hook`: pre-push 훅 설치 및 Worktree E2E (4/4)
- `test-diff-engine`: H1 섹션 분리 및 델타 재구성 (4/4)
- `test-exporter`: .gitignore 격리 및 아카이브 덤프 (3/3)
- `test-scaffold`: 초안 생성 및 --force 덮어쓰기 정책 (4/4)
- `test-doctor`: 전수 비중단 진단 및 HTTP 핑 (4/4)
- `test-search-engine`: YAML 프론트매터 및 BM25 스코어링 (7/7)
- `test-verifier`: Git Graph 드리프트 분석, Stderr 캡처 및 Strict 모드 (9/9)
- `test-sqlite-storage`: WAL 모드, BLOB 임베딩, B-Tree 룩업 및 CASCADE (5/5)
- `test-vector-worker`: VectorWorkerClient 및 VectorWorkerPool 멀티 워커 배치 (4/4)
- `test-index-cache`: 파일 락 상호 배제, Inode mtime 차분 및 batchEmbedFn (6/6)
- `test-vector-engine`: multilingual-e5 ONNX 384차원 임베딩 (3/3)
- `test-hybrid-search`: RRF 상호 순위 융합 및 워커 풀 배치 임베딩 (5/5)
