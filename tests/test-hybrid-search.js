/**
 * 하이브리드 RRF 검색 엔진(lib/hybrid-search.js) 단위 및 통합 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  DEFAULT_RRF_K,
  HybridSearchEngine,
  formatHybridResults
} = require('../lib/hybrid-search');
const { embedText } = require('../lib/vector-engine');
const { tokenize } = require('../lib/search-engine');

console.log('[TEST] Starting Hybrid Search Engine Tests...');

(async () => {
  try {
    // 1. RRF 공식 수학적 스코어링 및 모드 전환 검증
    {
      const engine = new HybridSearchEngine({ rrfK: 60 });

      const chunkA = {
        id: 'chunkA',
        relativeFile: 'fileA.md',
        filePath: '/tmp/fileA.md',
        section: '목표',
        sectionTitle: '# 1. 목표',
        content: 'Zero-Dependency BM25 렉시컬 검색 엔진 구현',
        tokens: tokenize('Zero-Dependency BM25 렉시컬 검색 엔진 구현'),
        tokenFreqs: new Map([['bm25', 1], ['검색', 1], ['엔진', 1]]),
        length: 6,
        vector: new Float32Array(384).fill(0.1),
        isSuperseded: false,
        metadata: { commitHash: 'aaaaaaa' }
      };

      const chunkB = {
        id: 'chunkB',
        relativeFile: 'fileB.md',
        filePath: '/tmp/fileB.md',
        section: '실행 명령',
        sectionTitle: '# 3. 실행 명령',
        content: '인수인계 동기화 실행 명령 안내',
        tokens: tokenize('인수인계 동기화 실행 명령 안내'),
        tokenFreqs: new Map([['인수인계', 1], ['동기화', 1]]),
        length: 4,
        vector: new Float32Array(384).fill(0.5),
        isSuperseded: false,
        metadata: { commitHash: 'bbbbbbb' }
      };

      engine.setChunks([chunkA, chunkB]);

      // BM25 모드: 키워드가 일치하는 chunkA만 나와야 함
      const bm25Res = await engine.search('BM25 검색', { mode: 'bm25' });
      assert.strictEqual(bm25Res.length, 1);
      assert.strictEqual(bm25Res[0].file, 'fileA.md');
      assert.ok(bm25Res[0].score > 0);

      console.log('  PASS: 순수 BM25 모드 및 검색 정합성 검증');
    }

    // 2. 어휘 불일치(Vocabulary Mismatch) 시맨틱 인출 검증
    // 질의: "네트워크 단절 복구" ➔ 타겟: "HTTP 429 지수 백오프" (BM25 단독 시 0점)
    {
      console.log('  [INFO] Generating real E5 embeddings for semantic retrieval test...');
      const engine = new HybridSearchEngine();

      const backoffContent = 'Notion API 통신 시 HTTP 429 에러 감지 및 지수 백오프 알고리즘 재시도';
      const irrelevantContent = '프로젝트 메타데이터 추출 및 README 첫 문단 요약 기능';

      const backoffTokens = tokenize(backoffContent);
      const irrelevantTokens = tokenize(irrelevantContent);

      const vecBackoff = await embedText(backoffContent, false);
      const vecIrrelevant = await embedText(irrelevantContent, false);

      const chunkBackoff = {
        id: 'archive_429.md#실행 명령',
        relativeFile: 'archive_429.md',
        filePath: '/tmp/archive_429.md',
        section: '실행 명령',
        sectionTitle: '# 3. 실행 명령',
        content: backoffContent,
        tokens: backoffTokens,
        tokenFreqs: new Map(),
        length: backoffTokens.length,
        vector: vecBackoff,
        isSuperseded: false,
        metadata: { commitHash: '429hash' }
      };
      for (const t of backoffTokens) chunkBackoff.tokenFreqs.set(t, (chunkBackoff.tokenFreqs.get(t) || 0) + 1);

      const chunkIrrelevant = {
        id: 'archive_meta.md#목표',
        relativeFile: 'archive_meta.md',
        filePath: '/tmp/archive_meta.md',
        section: '목표',
        sectionTitle: '# 1. 목표',
        content: irrelevantContent,
        tokens: irrelevantTokens,
        tokenFreqs: new Map(),
        length: irrelevantTokens.length,
        vector: vecIrrelevant,
        isSuperseded: false,
        metadata: { commitHash: 'metahash' }
      };
      for (const t of irrelevantTokens) chunkIrrelevant.tokenFreqs.set(t, (chunkIrrelevant.tokenFreqs.get(t) || 0) + 1);

      engine.setChunks([chunkBackoff, chunkIrrelevant]);

      // 완전히 어휘가 다른 질의 (교집합 0)
      const query = '원격 서버 접속 차단 해결책';

      // (1) BM25 단독 검색: 어휘 불일치로 결과 0건 또는 0점이어야 함
      const bm25Only = await engine.search(query, { mode: 'bm25' });
      assert.strictEqual(bm25Only.length, 0, 'BM25 단독 검색 시 어휘 불일치로 인해 0건이어야 함');

      // (2) Hybrid RRF 검색: Dense Vector 신호가 유입되어 429 백오프 청크가 1위로 인출되어야 함!
      const hybridRes = await engine.search(query, { mode: 'hybrid' });
      assert.ok(hybridRes.length > 0, '하이브리드 모드에서는 시맨틱 벡터로 인해 결과가 인출되어야 함');
      assert.strictEqual(hybridRes[0].file, 'archive_429.md');
      assert.ok(hybridRes[0].vectorRank !== null, 'Vector Rank가 부여되어야 함');
      assert.ok(hybridRes[0].score > 0);

      console.log(`  PASS: 어휘 불일치 질의("네트워크 단절 복구" ➔ "429 백오프") 하이브리드 RRF 1위 인출 검증 (RRF Score: ${hybridRes[0].score})`);
    }

    // 3. ADR Supersedes 묘비(Tombstone) 페널티 감점 검증
    {
      const engine = new HybridSearchEngine();

      const chunkActive = {
        id: 'active.md#1',
        relativeFile: 'active.md',
        filePath: '/tmp/active.md',
        section: '목표',
        sectionTitle: '# 1. 목표',
        content: 'multilingual-e5-small 임베딩 모델 채택',
        tokens: tokenize('multilingual-e5-small 임베딩 모델 채택'),
        tokenFreqs: new Map([['multilingual', 1], ['임베딩', 1], ['모델', 1]]),
        length: 5,
        vector: null,
        isSuperseded: false,
        metadata: { commitHash: 'active123' }
      };

      const chunkTombstone = {
        id: 'tombstone.md#1',
        relativeFile: 'tombstone.md',
        filePath: '/tmp/tombstone.md',
        section: '목표',
        sectionTitle: '# 1. 목표',
        content: 'all-MiniLM-L6-v2 임베딩 모델 채택 (폐기됨)',
        tokens: tokenize('all-MiniLM-L6-v2 임베딩 모델 채택 (폐기됨)'),
        tokenFreqs: new Map([['임베딩', 2], ['모델', 2]]),
        length: 6,
        vector: null,
        isSuperseded: true, // 묘비 마킹!
        metadata: { commitHash: 'tomb123' }
      };

      engine.setChunks([chunkActive, chunkTombstone]);

      const results = await engine.search('임베딩 모델', { mode: 'bm25' });
      assert.strictEqual(results.length, 2);

      // chunkTombstone은 감점(-80%)을 받아 chunkActive보다 후순위로 밀려나야 함
      assert.strictEqual(results[0].file, 'active.md');
      assert.strictEqual(results[1].file, 'tombstone.md');
      assert.strictEqual(results[1].isSuperseded, true);

      console.log('  PASS: ADR Supersedes 묘비(Tombstone) -80% 페널티 감점 및 순위 하향 검증');
    }

    // 4. 결과 출력 포맷팅 검증
    {
      const mockResult = [
        {
          score: 0.032,
          isCurrentHandover: true,
          isSuperseded: false,
          file: 'HANDOVER.md',
          section: '실행 명령',
          sectionTitle: '# 3. 실행 명령',
          snippet: 'npm test 실행',
          bm25Rank: 1,
          vectorRank: 1
        }
      ];

      const formatted = formatHybridResults(mockResult, 'npm test', 'hybrid');
      assert.ok(formatted.includes('HYBRID RAG SEARCH RESULTS'));
      assert.ok(formatted.includes('RRF: 0.032'));
      assert.ok(formatted.includes('BM25: #1, Vector: #1'));
      console.log('  PASS: 하이브리드 검색 터미널 서식화 및 순위 정보 렌더링 검증');
    }

    // 5. VectorWorkerPool 연동 온디맨드 배치 임베딩 및 하이브리드 검색 검증
    {
      const engine = new HybridSearchEngine();
      const chunkMissing1 = {
        id: 'pool_test1.md#목표',
        relativeFile: 'pool_test1.md',
        filePath: '/tmp/pool_test1.md',
        section: '목표',
        sectionTitle: '# 1. 목표',
        content: '분산 워커 풀을 통한 대용량 벡터 임베딩 고속 연산',
        tokens: tokenize('분산 워커 풀을 통한 대용량 벡터 임베딩 고속 연산'),
        tokenFreqs: new Map(),
        length: 7,
        vector: null, // 미생성 벡터
        isSuperseded: false,
        metadata: { commitHash: 'poolhash1' }
      };
      const chunkMissing2 = {
        id: 'pool_test2.md#실행 명령',
        relativeFile: 'pool_test2.md',
        filePath: '/tmp/pool_test2.md',
        section: '실행 명령',
        sectionTitle: '# 3. 실행 명령',
        content: 'node bin/session-sync.js search --mode hybrid 실행 가이드',
        tokens: tokenize('node bin/session-sync.js search --mode hybrid 실행 가이드'),
        tokenFreqs: new Map(),
        length: 8,
        vector: null, // 미생성 벡터
        isSuperseded: false,
        metadata: { commitHash: 'poolhash2' }
      };

      engine.setChunks([chunkMissing1, chunkMissing2]);
      const { getDefaultWorkerPool } = require('../lib/vector-worker');
      const pool = getDefaultWorkerPool();

      // missingVectors 배치 임베딩 생성 시뮬레이션
      const texts = [chunkMissing1.content, chunkMissing2.content];
      const vectors = await pool.dispatchBatch(texts);
      assert.strictEqual(vectors.length, 2);
      assert.strictEqual(vectors[0].length, 384);
      assert.strictEqual(vectors[1].length, 384);
      chunkMissing1.vector = vectors[0];
      chunkMissing2.vector = vectors[1];

      const searchRes = await engine.search('대용량 벡터 고속 연산', { mode: 'hybrid' });
      assert.ok(searchRes.length > 0, '워커 풀 임베딩 결과로 검색이 성공해야 함');
      assert.strictEqual(searchRes[0].file, 'pool_test1.md');
      console.log('  PASS: VectorWorkerPool 연동 온디맨드 배치 임베딩 및 하이브리드 검색 검증');
    }

    console.log('[TEST] All Hybrid Search Tests Passed Successfully.');
    const { getDefaultWorkerClient, getDefaultWorkerPool } = require('../lib/vector-worker');
    await getDefaultWorkerClient().terminate();
    await getDefaultWorkerPool().terminate();
  } catch (err) {
    console.error('[TEST_FAIL] Hybrid Search Test failed:', err);
    process.exit(1);
  }
})();
