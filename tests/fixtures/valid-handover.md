# 1. 목표
세션 메모리 CLI (session-sync) 모듈의 파서 및 2000자 블록 분할 로직을 완성하고 T01~T05 검사를 통과시킨다.

# 2. 현재 상태
CLI 라우팅 및 인자 파싱 완료 (커밋 f2715f7). 마크다운 7칸 유효성 검증기 작성 진행 중.

# 3. 실행 명령
```powershell
node ./bin/session-sync.js --help
node ./tests/test-cli-routing.js
```

# 4. 통과 검사
T01 CLI 진입점 인자 검증 및 T02 정상 인수인계 파싱 단위 테스트 통과 완료.

# 5. 남은 문제
Notion REST API 통신 모듈 및 429 Rate-limit 재시도 백오프 로직 미구현 (T06~T10 미통과 상태).

# 6. 다음 행동
`lib/block-transformer.js`를 작성하여 2000자 청크 분할 및 Notion Block 스키마 변환기를 구현한다.

# 7. 건드리지 말 것
`bin/session-sync.js`의 기존 인수 파싱 로직 및 CLI 인터페이스 하위 호환성을 깨뜨리지 말 것.
