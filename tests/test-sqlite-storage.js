const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SqliteStorage } = require('../lib/sqlite-storage');

const TEST_OUT_DIR = path.resolve(__dirname, 'out', 'test-sqlite');
const TEST_DB_PATH = path.resolve(TEST_OUT_DIR, 'test-session.db');

function cleanup() {
  if (fs.existsSync(TEST_OUT_DIR)) {
    fs.rmSync(TEST_OUT_DIR, { recursive: true, force: true });
  }
}

async function runTests() {
  console.log('[TEST] Starting SQLite Storage Tests...');
  cleanup();

  let storage = null;

  try {
    // 1. DB 초기화 및 WAL 모드 검증
    storage = new SqliteStorage(TEST_DB_PATH);
    assert.strictEqual(fs.existsSync(TEST_DB_PATH), true, 'SQLite DB 파일이 생성되어야 합니다.');

    const pragmaRow = storage.db.prepare('PRAGMA journal_mode;').get();
    assert.strictEqual(pragmaRow.journal_mode.toLowerCase(), 'wal', 'WAL 저널 모드가 활성화되어야 합니다.');
    console.log('  PASS: DB 생성 및 WAL 모드 활성화 검증');

    // 2. 단일 및 배치 청크/임베딩/역색인 삽입 및 무결성 검증
    const vecA = new Float32Array([1.0, 0.0, 0.0, 0.5]);
    const termsA = new Map([
      ['백오프', 2],
      ['재시도', 1]
    ]);

    storage.upsertChunk({
      id: 'chunk_001',
      archiveFile: 'session1.md',
      section: '실행 명령',
      content: '지수 백오프 재시도 로직 실행',
      mtimeMs: 1700000000000,
      isTombstone: false
    }, vecA, termsA);

    const chunk1 = storage.getChunk('chunk_001');
    assert.ok(chunk1, 'chunk_001이 조회되어야 합니다.');
    assert.strictEqual(chunk1.section, '실행 명령');
    assert.strictEqual(chunk1.isTombstone, false);

    const embed1 = storage.getEmbedding('chunk_001');
    assert.ok(embed1, '임베딩 벡터가 복원되어야 합니다.');
    assert.strictEqual(embed1.length, 4);
    assert.strictEqual(embed1[0], 1.0);
    assert.strictEqual(embed1[3], 0.5);

    const termResults = storage.searchInvertedIndex(['백오프', '미존재']);
    assert.strictEqual(termResults.length, 1);
    assert.strictEqual(termResults[0].chunkId, 'chunk_001');
    assert.strictEqual(termResults[0].tf, 2);
    console.log('  PASS: 청크, BLOB 임베딩 벡터 및 역색인 단일 저장/복원 검증');

    // 3. 배치 저장(upsertChunksBatch) 및 코사인 유사도 랭킹 검증
    const vecB = new Float32Array([0.0, 1.0, 0.0, 0.0]); // vecA와 직교
    const vecC = new Float32Array([0.9, 0.1, 0.0, 0.4]); // vecA와 유사

    storage.upsertChunksBatch([
      {
        chunk: {
          id: 'chunk_002',
          archiveFile: 'session1.md',
          section: '현재 상태',
          content: '직교 벡터 청크',
          mtimeMs: 1700000000000
        },
        embedding: vecB,
        tokenFreqs: { 직교: 1 }
      },
      {
        chunk: {
          id: 'chunk_003',
          archiveFile: 'session2.md',
          section: '목표',
          content: '유사 벡터 청크',
          mtimeMs: 1700000010000
        },
        embedding: vecC,
        tokenFreqs: { 유사: 3 }
      }
    ]);

    const stats = storage.getStats();
    assert.strictEqual(stats.chunkCount, 3);
    assert.strictEqual(stats.embeddingCount, 3);

    // queryVec: [1.0, 0.0, 0.0, 0.0]
    const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
    const searchResults = storage.searchCosine(queryVec, { limit: 2 });
    assert.strictEqual(searchResults.length, 2);
    assert.strictEqual(searchResults[0].chunkId, 'chunk_001', '내적이 1.0인 chunk_001이 1위여야 합니다.');
    assert.strictEqual(searchResults[1].chunkId, 'chunk_003', '내적이 0.9인 chunk_003이 2위여야 합니다.');
    console.log('  PASS: 배치 삽입 및 BLOB 기반 온디맨드 코사인 유사도 연산 검증');

    // 4. 메타데이터 입출력 검증
    storage.setMetadata('corpusStats', { docCount: 3, avgDocLength: 42 });
    const meta = storage.getMetadata('corpusStats', true);
    assert.strictEqual(meta.docCount, 3);
    assert.strictEqual(meta.avgDocLength, 42);
    console.log('  PASS: JSON 메타데이터 영속화 및 역직렬화 검증');

    // 5. 외래 키 CASCADE 삭제 검증 (deleteChunksByFile)
    const deletedCount = storage.deleteChunksByFile('session1.md');
    assert.strictEqual(deletedCount, 2, 'session1.md의 2개 청크가 삭제되어야 합니다.');

    assert.strictEqual(storage.getChunk('chunk_001'), null, 'chunk_001은 삭제되어야 합니다.');
    assert.strictEqual(storage.getEmbedding('chunk_001'), null, 'CASCADE에 의해 chunk_001 임베딩도 삭제되어야 합니다.');
    const termsAfter = storage.searchInvertedIndex(['백오프']);
    assert.strictEqual(termsAfter.length, 0, 'CASCADE에 의해 chunk_001 역색인도 삭제되어야 합니다.');

    const remainChunk = storage.getChunk('chunk_003');
    assert.ok(remainChunk, 'session2.md의 chunk_003은 온전히 보존되어야 합니다.');
    console.log('  PASS: 파일 단위 삭제 시 외래 키 CASCADE 전파 무결성 검증');

  } finally {
    if (storage) {
      storage.close();
    }
    cleanup();
  }

  console.log('[TEST] All SQLite Storage Tests Passed Successfully.\n');
}

runTests().catch((err) => {
  console.error('[TEST FAILED]', err);
  process.exit(1);
});
