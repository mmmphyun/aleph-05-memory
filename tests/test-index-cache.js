/**
 * 증분 인덱스 캐시(lib/index-cache.js) 단위 및 통합 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_INDEX_PATH,
  createEmptyIndex,
  loadIndex,
  saveIndex,
  scanFileChanges,
  applySupersedesTombstones,
  buildInvertedIndex,
  IndexCache
} = require('../lib/index-cache');

console.log('[TEST] Starting Index Cache Tests...');

const testOutDir = path.resolve(process.cwd(), 'tests', 'out', 'test-index-cache');
if (fs.existsSync(testOutDir)) {
  fs.rmSync(testOutDir, { recursive: true, force: true });
}
fs.mkdirSync(testOutDir, { recursive: true });

const testArchiveDir = path.join(testOutDir, 'archives');
const testCachePath = path.join(testOutDir, 'index.json');
const testHandoverPath = path.join(testOutDir, 'HANDOVER.md');
fs.mkdirSync(testArchiveDir, { recursive: true });

// 1. 기본 인덱스 구조 및 저장/로드 무결성 테스트
{
  const empty = createEmptyIndex();
  assert.strictEqual(empty.version, 1);
  assert.strictEqual(empty.corpusStats.docCount, 0);
  assert.deepStrictEqual(empty.chunks, []);

  // Map 객체가 포함된 청크 저장 및 역직렬화 복원 테스트
  const mockChunks = [
    {
      id: 'test.md#목표',
      filePath: '/tmp/test.md',
      relativeFile: 'test.md',
      relativeKey: 'test.md',
      section: '목표',
      sectionTitle: '# 1. 목표',
      content: '캐시 테스트 청크 내용',
      metadata: { commitHash: 'abc1234' },
      tokens: ['캐시', '테스트'],
      tokenFreqs: new Map([['캐시', 2], ['테스트', 1]]),
      length: 2,
      vector: [0.1, 0.2, 0.3],
      isSuperseded: false
    }
  ];

  const indexData = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    corpusStats: { docCount: 1, avgDocLength: 2 },
    mtimeMap: { 'test.md': 123456789 },
    chunks: mockChunks,
    invertedIndex: { '캐시': [{ chunkId: 'test.md#목표', tf: 2 }] }
  };

  saveIndex(indexData, testCachePath);
  assert.ok(fs.existsSync(testCachePath));

  const loaded = loadIndex(testCachePath);
  assert.strictEqual(loaded.version, 1);
  assert.strictEqual(loaded.chunks.length, 1);
  assert.ok(loaded.chunks[0].tokenFreqs instanceof Map);
  assert.strictEqual(loaded.chunks[0].tokenFreqs.get('캐시'), 2);
  assert.strictEqual(loaded.chunks[0].tokenFreqs.get('테스트'), 1);
  assert.deepStrictEqual(loaded.chunks[0].vector, [0.1, 0.2, 0.3]);
  console.log('  PASS: index.json 저장, 원자적 쓰기 및 tokenFreqs Map 복원 무결성');
}

// 2. Inode mtime 기반 차분 감지(Incremental Scan) 및 캐시 갱신 테스트
{
  const file1 = path.join(testArchiveDir, '20260920_100000_1111111_A_END.md');
  const file1Content = `---
commit_hash: 1111111
archived_at: 2026-09-20T10:00:00.000Z
phase: A_END
---

# 1. 목표
세션 메모리 최초 구축

# 2. 현재 상태
- 초기 세션
`;
  fs.writeFileSync(file1, file1Content, 'utf8');

  const cache = new IndexCache({
    archiveDir: testArchiveDir,
    cachePath: testCachePath,
    handoverPath: testHandoverPath,
    includeCurrentHandover: false
  });

  // 최초 빌드: 1개 파일 추가 감지 (Added: 1, Unchanged: 0)
  const res1 = cache.loadOrBuildSync();
  assert.strictEqual(res1.stats.added, 1);
  assert.strictEqual(res1.stats.unchanged, 0);
  assert.strictEqual(res1.chunks.length, 2); // 목표, 현재 상태 2개 청크
  assert.strictEqual(res1.corpusStats.docCount, 2);

  // 2차 로드: 변경 없음 -> 캐시 히트 (Added: 0, CacheHit: true)
  const res2 = cache.loadOrBuildSync();
  assert.strictEqual(res2.stats.cacheHit, true);
  assert.strictEqual(res2.stats.added, 0);
  assert.strictEqual(res2.stats.modified, 0);

  // 신규 파일 2 추가 (Added: 1, Unchanged: 1)
  const file2 = path.join(testArchiveDir, '20260921_100000_2222222_B_END.md');
  const file2Content = `---
commit_hash: 2222222
archived_at: 2026-09-21T10:00:00.000Z
phase: B_END
---

# 1. 목표
BM25 검색 엔진 추가

# 2. 현재 상태
- BM25 구현 완료
`;
  fs.writeFileSync(file2, file2Content, 'utf8');

  const res3 = cache.loadOrBuildSync();
  assert.strictEqual(res3.stats.added, 1);
  assert.strictEqual(res3.stats.unchanged, 1);
  assert.strictEqual(res3.stats.modified, 0);
  assert.strictEqual(res3.chunks.length, 4);

  // 파일 2 수정: mtime 갱신 (Modified: 1, Unchanged: 1)
  // mtime 차이를 명확히 하기 위해 utimesSync 적용
  const updatedTime = Date.now() / 1000 + 10;
  fs.writeFileSync(file2, file2Content + '\n# 3. 실행 명령\nnpm test\n', 'utf8');
  fs.utimesSync(file2, updatedTime, updatedTime);

  const res4 = cache.loadOrBuildSync();
  assert.strictEqual(res4.stats.modified, 1);
  assert.strictEqual(res4.stats.unchanged, 1);
  assert.strictEqual(res4.chunks.length, 5); // 2개 + 3개 = 5개 청크

  // 파일 1 삭제: Deleted 감지 (Deleted: 1, Unchanged: 1)
  fs.unlinkSync(file1);
  const res5 = cache.loadOrBuildSync();
  assert.strictEqual(res5.stats.deleted, 1);
  assert.strictEqual(res5.stats.unchanged, 1);
  assert.strictEqual(res5.chunks.length, 3); // file2 청크만 남음

  console.log('  PASS: Inode mtime 기반 Added/Modified/Deleted 차분 감지 및 증분 갱신');
}

// 3. ADR Supersedes 묘비(Tombstone) 무효화 검증
{
  const oldChunk = {
    id: 'old.md#현재 상태',
    relativeFile: 'old.md',
    content: '[채택]: all-MiniLM-L6-v2 모델 채택',
    metadata: { commitHash: 'oldhash123' },
    isSuperseded: false
  };

  const newChunk = {
    id: 'new.md#현재 상태',
    relativeFile: 'new.md',
    content: '[채택]: multilingual-e5-small 채택 (supersedes: oldhash123)',
    metadata: { commitHash: 'newhash456', supersedes: 'oldhash123' },
    isSuperseded: false
  };

  const chunks = [oldChunk, newChunk];
  applySupersedesTombstones(chunks);

  assert.strictEqual(oldChunk.isSuperseded, true);
  assert.strictEqual(newChunk.isSuperseded, false);
  console.log('  PASS: ADR Supersedes 묘비(Tombstone) 감지 및 이전 세션 가설 무효화');
}

// 4. 역색인(Inverted Index) 및 코퍼스 통계 구축 검증
{
  const testChunks = [
    {
      id: 'docA#1',
      length: 3,
      tokenFreqs: new Map([['bm25', 2], ['search', 1]])
    },
    {
      id: 'docB#1',
      length: 2,
      tokenFreqs: new Map([['bm25', 1], ['hybrid', 1]])
    }
  ];

  const { invertedIndex, corpusStats } = buildInvertedIndex(testChunks);
  assert.strictEqual(corpusStats.docCount, 2);
  assert.strictEqual(corpusStats.avgDocLength, 2.5);
  assert.strictEqual(invertedIndex['bm25'].length, 2);
  assert.strictEqual(invertedIndex['bm25'][0].chunkId, 'docA#1');
  assert.strictEqual(invertedIndex['bm25'][0].tf, 2);
  assert.strictEqual(invertedIndex['hybrid'].length, 1);
  console.log('  PASS: 역색인(Inverted Index) 텀 빈도 매핑 및 코퍼스 통계 산출');
}

// 5. 비동기 loadOrBuild 및 embedFn 바인딩 검증
(async () => {
  const dummyEmbedFn = async (text) => {
    return [0.5, 0.5, 0.5];
  };

  const cache = new IndexCache({
    archiveDir: testArchiveDir,
    cachePath: path.join(testOutDir, 'async-index.json'),
    includeCurrentHandover: false
  });

  const res = await cache.loadOrBuild({ embedFn: dummyEmbedFn, forceRebuild: true });
  assert.ok(res.chunks.length > 0);
  assert.deepStrictEqual(res.chunks[0].vector, [0.5, 0.5, 0.5]);
  console.log('  PASS: 비동기 loadOrBuild 및 embedFn 벡터 주입 검증');

  console.log('[TEST] All Index Cache Tests Passed Successfully.');
})();
