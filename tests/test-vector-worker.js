const assert = require('node:assert');
const { VectorWorkerClient } = require('../lib/vector-worker');

async function runTests() {
  console.log('[TEST] Starting Vector Worker Tests...');

  // 1. In-process 폴백 모드 검증
  const fallbackClient = new VectorWorkerClient({ disableWorker: true });
  const fallbackVec = await fallbackClient.embed('테스트 인프로세스', true);
  assert.ok(fallbackVec instanceof Float32Array, 'Float32Array가 반환되어야 합니다.');
  assert.strictEqual(fallbackVec.length, 384, '384차원 벡터여야 합니다.');
  await fallbackClient.terminate();
  console.log('  PASS: In-process 폴백 모드 임베딩 검증');

  // 2. worker_threads 기반 백그라운드 워커 모드 검증
  const workerClient = new VectorWorkerClient({ timeoutMs: 25000 });
  try {
    const queryVec = await workerClient.embed('HTTP 429 지수 백오프', true);
    assert.ok(queryVec instanceof Float32Array, 'Float32Array가 반환되어야 합니다.');
    assert.strictEqual(queryVec.length, 384, '384차원이어야 합니다.');
    console.log('  PASS: worker_threads 비동기 단일 임베딩 디스패치 검증');

    // 3. 배치 임베딩 디스패치 검증
    const batchTexts = [
      '첫 번째 세션 청크 본문',
      '두 번째 세션 청크 본문'
    ];
    const batchVecs = await workerClient.batchEmbed(batchTexts);
    assert.strictEqual(batchVecs.length, 2, '2개의 벡터가 반환되어야 합니다.');
    assert.strictEqual(batchVecs[0].length, 384);
    assert.strictEqual(batchVecs[1].length, 384);
    console.log('  PASS: worker_threads 비동기 배치 임베딩 디스패치 검증');

  } finally {
    await workerClient.terminate();
  }

  console.log('[TEST] All Vector Worker Tests Passed Successfully.\n');
}

runTests().catch((err) => {
  console.error('[TEST FAILED]', err);
  process.exit(1);
});
