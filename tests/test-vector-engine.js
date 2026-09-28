/**
 * 로컬 다국어 임베딩 엔진(lib/vector-engine.js) 단위 및 통합 테스트
 */

const assert = require('node:assert');
const {
  normalizeL2,
  cosineSimilarity,
  embedText,
  batchEmbedPassages
} = require('../lib/vector-engine');

console.log('[TEST] Starting Vector Engine Tests...');

// 1. L2 정규화 및 코사인 유사도 수학적 정합성 검증
{
  const v1 = new Float32Array([3, 4]); // norm = 5
  const normV1 = normalizeL2(v1);
  assert.strictEqual(Number(normV1[0].toFixed(1)), 0.6);
  assert.strictEqual(Number(normV1[1].toFixed(1)), 0.8);

  // 자기 자신과의 코사인 유사도 = 1.0
  const simSelf = cosineSimilarity(normV1, normV1);
  assert.strictEqual(Number(simSelf.toFixed(4)), 1.0);

  // 직교 벡터와의 코사인 유사도 = 0.0
  const vOrthogonal = normalizeL2(new Float32Array([-4, 3]));
  const simOrth = cosineSimilarity(normV1, vOrthogonal);
  assert.strictEqual(Number(simOrth.toFixed(4)), 0.0);

  // 반대 벡터와의 코사인 유사도 = -1.0
  const vOpposite = normalizeL2(new Float32Array([-3, -4]));
  const simOpp = cosineSimilarity(normV1, vOpposite);
  assert.strictEqual(Number(simOpp.toFixed(4)), -1.0);

  console.log('  PASS: L2 정규화 및 코사인 유사도 내적 계산 정합성');
}

// 2. multilingual-e5-small INT8 ONNX 모델 로딩 및 비대칭 임베딩/시맨틱 유사도 검증
(async () => {
  try {
    console.log('  [INFO] Initializing ONNX runtime and downloading/loading E5 INT8 model (~118MB)...');
    const startLoad = Date.now();

    const query = '네트워크 단절 복구';
    const relevantPassage = 'HTTP 429 지수 백오프 알고리즘을 통한 장애 복구 및 재시도 메커니즘';
    const irrelevantPassage = '오늘 저녁 식사 메뉴는 삼겹살과 된장찌개입니다';

    const qVec = await embedText(query, true);
    assert.strictEqual(qVec.length, 384);

    const relVec = await embedText(relevantPassage, false);
    assert.strictEqual(relVec.length, 384);

    const irrelVec = await embedText(irrelevantPassage, false);
    assert.strictEqual(irrelVec.length, 384);

    const elapsed = Date.now() - startLoad;
    console.log(`  [INFO] Model loaded and 3 embeddings generated in ${elapsed}ms`);

    const simRelevant = cosineSimilarity(qVec, relVec);
    const simIrrelevant = cosineSimilarity(qVec, irrelVec);

    console.log(`  [INFO] Similarity (Query <-> 429 지수 백오프): ${simRelevant}`);
    console.log(`  [INFO] Similarity (Query <-> 삼겹살): ${simIrrelevant}`);

    // 시맨틱 의미 매칭 불변식: 도메인 관련 패시지 유사도가 무관한 패시지보다 유의미하게 높아야 함
    assert.ok(simRelevant > simIrrelevant);
    assert.ok(simRelevant > 0.8, `Expected simRelevant > 0.8, got ${simRelevant}`);
    assert.ok(simRelevant - simIrrelevant > 0.05, 'Semantic margin should be at least 0.05');

    console.log('  PASS: multilingual-e5-small 384차원 임베딩 및 어휘 불일치 시맨틱 유사도 검증');

    // 3. 배치 패시지 임베딩 검증
    const batchTexts = [
      'lib/search-engine.js 토크나이저',
      'lib/verifier.js 불변식 검증기'
    ];
    let progressCount = 0;
    const batchVectors = await batchEmbedPassages(batchTexts, {
      onProgress: (done, total) => {
        progressCount = done;
      }
    });

    assert.strictEqual(batchVectors.length, 2);
    assert.strictEqual(batchVectors[0].length, 384);
    assert.strictEqual(progressCount, 2);
    console.log('  PASS: batchEmbedPassages 배치 임베딩 및 프로그레스 콜백 검증');

    console.log('[TEST] All Vector Engine Tests Passed Successfully.');
  } catch (err) {
    console.error('[TEST_FAIL] Vector Engine Test failed:', err);
    process.exit(1);
  }
})();
