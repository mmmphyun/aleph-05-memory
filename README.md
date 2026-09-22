# session-sync: 멀티 AI 세션 메모리 및 노션 동기화 엔진

여러 LLM 세션(A ➔ B)이 교체되거나 대화 컨텍스트가 초기화되어도, Notion Database를 외부 지속성 메모리로 활용하여 작업 인수인계(7항목 규격)와 프로젝트 상태를 온전히 이어받을 수 있도록 지원하는 무의존성(Zero-dependency) Node.js CLI 도구입니다.

---

## 주요 기능 및 아키텍처

1. **7칸 인수인계 무결성 가드레일 (`lib/markdown-parser.js`)**:
   - `목표`, `현재 상태`, `실행 명령`, `통과 검사`, `남은 문제`, `다음 행동`, `건드리지 말 것` 필수 7개 섹션 전수 검증.
   - `TODO`, `N/A`, `없음` 등 에이전트의 회피성 플레이스홀더 단독 기재 시 즉시 하드 차단(`exit 1`).
2. **2계층 Leaf-Parent 메모리 구조 (토큰 폭발 원천 차단)**:
   - **Leaf (메타데이터 속성)**: 제목, 프로젝트, 페이즈, 커밋 해시, 통과 수 등 초경량 인덱스 조회(`--list`).
   - **Parent (본문 블록)**: 인수인계 상세 마크다운 본문 선택적 복원(`--latest`, `--tag`).
3. **Notion API 2,000자 블록 청크 자동 분할 (`lib/block-transformer.js`)**:
   - Notion REST API의 단일 텍스트 블록 2,000자 제한을 초과하는 로그나 코드를 문장/개행 단위로 자동 분할 적재.
4. **오프라인 내결함성 로컬 캐시 (`lib/local-cache.js`)**:
   - 네트워크 단절 또는 API 호출 실패 시 `.sync_cache/` 디렉토리에 JSON 스냅샷을 영구 보존하여 손실 방지.
5. **순수 Node.js 내장 모듈 (Zero-Dependency)**:
   - `npm install` 없이 `node:https`, `node:fs`, `node:child_process` 표준 라이브러리만으로 동작하여 어떤 환경에서도 즉시 재현 가능.

---

## 빠른 시작 (Quick Start)

### 1. 환경 변수 설정 (`.env`)
```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 2. 전체 단위 및 통합 테스트 실행
```powershell
npm test
```

### 3. CLI 명령어 사용법

```powershell
# 도움말 확인
node ./bin/session-sync.js --help

# 1. 빈 Notion 페이지에 세션 메모리 DB 스키마 생성
node ./bin/session-sync.js init --parent <NOTION_PAGE_ID>

# 2. 작업 인수인계서 검증 및 Notion/캐시 적재 (드라이런 지원)
node ./bin/session-sync.js push --file ./HANDOVER.md --phase A_END --pass 5 --fail 5

# 3. 과거 세션 목록(Leaf 속성) 경량 조회
node ./bin/session-sync.js fetch --list

# 4. 직전 세션 인수인계 본문 복원
node ./bin/session-sync.js fetch --latest --out ./HANDOVER.md
```
