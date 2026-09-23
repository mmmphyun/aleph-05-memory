/**
 * 로컬 BM25 검색 엔진 단위 및 통합 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseFrontmatter,
  tokenize,
  chunkMarkdownBySections,
  BM25SearchEngine,
  normalizeSectionFilter,
  extractSnippet,
  loadAllChunks,
  formatSearchResults
} = require('../lib/search-engine');

console.log('[TEST] Starting Search Engine (BM25) Tests...');

// 1. 프론트매터 파싱 테스트
{
  const rawWithFrontmatter = `---
archived_at: 2026-09-23T15:00:00.000Z
project: aleph-05-memory
phase: A_END
commit_hash: 029d1d840cb1bef8f381890c24b46355706e109f
pass_count: 14
fail_count: 0
tags: session, memory, bm25
---

# 1. 목표
BM25 검색 엔진 구축`;

  const parsed = parseFrontmatter(rawWithFrontmatter);
  assert.strictEqual(parsed.metadata.project, 'aleph-05-memory');
  assert.strictEqual(parsed.metadata.pass_count, 14);
  assert.deepStrictEqual(parsed.metadata.tags, ['session', 'memory', 'bm25']);
  assert.ok(parsed.body.includes('# 1. 목표'));
  console.log('  PASS: YAML 프론트매터 및 메타데이터 정밀 파싱');
}

// 2. 개발 도메인 특화 토크나이저 테스트
{
  const text = 'BM25SearchEngine in lib/search-engine.js returned HTTP 429 for commit 029d1d840cb1bef8f381890c24b46355706e109f';
  const tokens = tokenize(text);

  // CamelCase 분리 검증
  assert.ok(tokens.includes('search'));
  assert.ok(tokens.includes('engine'));

  // 파일 경로 및 확장자 검증
  assert.ok(tokens.includes('.js'));
  assert.ok(tokens.includes('search-engine'));

  // 에러 코드 검증
  assert.ok(tokens.includes('429'));

  // Git 해시 및 축약 해시 검증
  assert.ok(tokens.includes('029d1d8'));
  console.log('  PASS: CamelCase, 경로, 에러코드, Git 해시 특화 토크나이징 검증');
}

// 3. 7섹션 마크다운 파티셔닝 테스트
{
  const markdown = `# 1. 목표
검색 엔진 구현

# 2. 현재 상태
- 베이스 커밋: 029d1d8

# 3. 실행 명령
\`\`\`powershell
npm test
\`\`\`

# 4. 통과 검사
전체 테스트 통과

# 5. 남은 문제
없음

# 6. 다음 행동
- 대상 파일: \`lib/verifier.js\`

# 7. 건드리지 말 것
- \`lib/markdown-parser.js\` 수정 금지
`;

  const chunks = chunkMarkdownBySections(markdown, {
    filePath: 'test/HANDOVER.md',
    commitHash: '029d1d8'
  });

  assert.strictEqual(chunks.length, 7);
  assert.strictEqual(chunks[0].section, '목표');
  assert.strictEqual(chunks[5].section, '다음 행동');
  assert.ok(chunks[5].tokens.includes('verifier'));
  console.log('  PASS: 7섹션 단위 청크 분할 및 메타데이터 바인딩');
}

// 4. BM25 랭킹 및 스코어링 테스트
{
  const doc1 = {
    section: '목표',
    sectionTitle: '# 1. 목표',
    relativeFile: 'archive_01.md',
    filePath: '/tmp/archive_01.md',
    content: 'BM25 렉시컬 검색 엔진 구현 및 성능 최적화 진행',
    metadata: { commitHash: 'aaaaaaa', archivedAt: '2026-09-20' },
    tokens: tokenize('BM25 렉시컬 검색 엔진 구현 및 성능 최적화 진행'),
    tokenFreqs: new Map(),
    length: 0
  };
  doc1.length = doc1.tokens.length;
  for (const t of doc1.tokens) doc1.tokenFreqs.set(t, (doc1.tokenFreqs.get(t) || 0) + 1);

  const doc2 = {
    section: '실행 명령',
    sectionTitle: '# 3. 실행 명령',
    relativeFile: 'archive_02.md',
    filePath: '/tmp/archive_02.md',
    content: 'Notion Client HTTP 429 에러 발생 시 지수 백오프 재시도',
    metadata: { commitHash: 'bbbbbbb', archivedAt: '2026-09-21' },
    tokens: tokenize('Notion Client HTTP 429 에러 발생 시 지수 백오프 재시도'),
    tokenFreqs: new Map(),
    length: 0
  };
  doc2.length = doc2.tokens.length;
  for (const t of doc2.tokens) doc2.tokenFreqs.set(t, (doc2.tokenFreqs.get(t) || 0) + 1);

  const engine = new BM25SearchEngine();
  engine.indexChunks([doc1, doc2]);

  // 검색 1: BM25 검색 ➔ doc1이 1위여야 함
  const res1 = engine.search('BM25 렉시컬 검색');
  assert.ok(res1.length > 0);
  assert.strictEqual(res1[0].file, 'archive_01.md');
  assert.ok(res1[0].score > 0);

  // 검색 2: 429 백오프 ➔ doc2가 1위여야 함
  const res2 = engine.search('429 백오프');
  assert.ok(res2.length > 0);
  assert.strictEqual(res2[0].file, 'archive_02.md');

  // 검색 3: 무관한 단어 ➔ 결과 0건
  const res3 = engine.search('nonexistentwordxyz');
  assert.strictEqual(res3.length, 0);

  console.log('  PASS: BM25 랭킹 스코어링 및 검색 정확도(Recall) 검증');
}

// 5. 섹션 필터링 테스트
{
  const docA = {
    section: '목표',
    sectionTitle: '# 1. 목표',
    relativeFile: 'handover.md',
    filePath: '/tmp/handover.md',
    content: '테스트 환경 구축',
    metadata: {},
    tokens: tokenize('테스트 환경 구축'),
    tokenFreqs: new Map(),
    length: 0
  };
  docA.length = docA.tokens.length;
  for (const t of docA.tokens) docA.tokenFreqs.set(t, (docA.tokenFreqs.get(t) || 0) + 1);

  const docB = {
    section: '다음 행동',
    sectionTitle: '# 6. 다음 행동',
    relativeFile: 'handover.md',
    filePath: '/tmp/handover.md',
    content: '테스트 코드 추가 작성',
    metadata: {},
    tokens: tokenize('테스트 코드 추가 작성'),
    tokenFreqs: new Map(),
    length: 0
  };
  docB.length = docB.tokens.length;
  for (const t of docB.tokens) docB.tokenFreqs.set(t, (docB.tokenFreqs.get(t) || 0) + 1);

  const engine = new BM25SearchEngine();
  engine.indexChunks([docA, docB]);

  // 다음 행동(next) 필터 적용 시 docB만 나와야 함
  const resNext = engine.search('테스트', { section: 'next' });
  assert.strictEqual(resNext.length, 1);
  assert.strictEqual(resNext[0].section, '다음 행동');

  // 목표(1) 필터 적용 시 docA만 나와야 함
  const resGoal = engine.search('테스트', { section: '1' });
  assert.strictEqual(resGoal.length, 1);
  assert.strictEqual(resGoal[0].section, '목표');

  console.log('  PASS: 섹션 필터링(영문 alias, 숫자, 한글) 정합성 검증');
}

// 6. 스니펫 및 포맷팅 검증
{
  const content = `줄 1: 시스템 초기화
줄 2: lib/search-engine.js 에서 발생한 오류 추적
줄 3: 성공적으로 완료됨`;
  const snippet = extractSnippet(content, ['search-engine'], 100);
  assert.ok(snippet.includes('lib/search-engine.js'));

  const formatted = formatSearchResults([
    {
      score: 1.2345,
      isCurrentHandover: true,
      file: 'HANDOVER.md',
      section: '다음 행동',
      sectionTitle: '# 6. 다음 행동',
      snippet: '테스트 코드 작성'
    }
  ], '테스트');
  assert.ok(formatted.includes('SESSION MEMORY BM25 SEARCH RESULTS'));
  assert.ok(formatted.includes('[CURRENT_HANDOVER]'));
  console.log('  PASS: 검색 스니펫 추출 및 터미널 출력 포맷팅 검증');
}

// 7. 디렉토리 기반 스캔 및 인제스천 E2E 테스트
{
  const tempDir = path.resolve(process.cwd(), 'tests', 'out', 'test-search');
  const archiveDir = path.join(tempDir, 'archives');
  fs.mkdirSync(archiveDir, { recursive: true });

  const dummyArchive = `---
archived_at: 2026-09-23T10:00:00.000Z
commit_hash: ccccccc
phase: B_START
---

# 1. 목표
신규 세션 동기화

# 2. 현재 상태
- 진행 중
`;
  fs.writeFileSync(path.join(archiveDir, '20260923_100000_ccccccc_B_START.md'), dummyArchive, 'utf8');

  const chunks = loadAllChunks({
    archiveDir,
    includeCurrentHandover: false
  });
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].metadata.commitHash, 'ccccccc');
  console.log('  PASS: 아카이브 디렉토리 스캔 및 청크 인제스천 E2E 검증');
}

console.log('[TEST] All Search Engine Tests Passed Successfully.');
