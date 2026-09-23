/**
 * 오프라인 Pending 재시도 큐 단위 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  savePendingSession,
  getPendingQueue,
  markPendingCompleted
} = require('../lib/local-cache');

console.log('[TEST] Starting Pending Queue Tests...');

const tempCacheDir = path.resolve(__dirname, 'out/test-pending-cache');
if (fs.existsSync(tempCacheDir)) {
  fs.rmSync(tempCacheDir, { recursive: true, force: true });
}

// 1. Pending 세션 적재 검증
{
  const session1 = {
    project: 'aleph-test',
    phase: 'A_END',
    commitHash: '1111111111111111111111111111111111111111',
    summary: 'Pending session 1'
  };
  const session2 = {
    project: 'aleph-test',
    phase: 'B_END',
    commitHash: '2222222222222222222222222222222222222222',
    summary: 'Pending session 2'
  };

  const file1 = savePendingSession(session1, tempCacheDir);
  const file2 = savePendingSession(session2, tempCacheDir);

  assert.ok(fs.existsSync(file1), 'Pending 세션 1 파일 생성되어야 함');
  assert.ok(fs.existsSync(file2), 'Pending 세션 2 파일 생성되어야 함');
  console.log('  PASS: Pending 디렉토리 내 세션 스냅샷 적재');

  // 2. FIFO 큐 조회 검증
  const queue = getPendingQueue(tempCacheDir);
  assert.strictEqual(queue.length, 2, '대기 중인 큐 아이템은 2개여야 함');
  assert.strictEqual(queue[0].summary, 'Pending session 1');
  assert.strictEqual(queue[1].summary, 'Pending session 2');
  console.log('  PASS: FIFO 정렬된 Pending 큐 목록 조회');

  // 3. 완료 처리 (completed 디렉토리 이동) 검증
  markPendingCompleted(queue[0].fullPath, tempCacheDir);
  const remainingQueue = getPendingQueue(tempCacheDir);
  assert.strictEqual(remainingQueue.length, 1, '완료 처리 후 남은 큐 아이템은 1개여야 함');
  assert.strictEqual(remainingQueue[0].summary, 'Pending session 2');

  const completedDir = path.join(tempCacheDir, 'completed');
  assert.ok(fs.existsSync(completedDir), 'completed 디렉토리 존재해야 함');
  const completedFiles = fs.readdirSync(completedDir);
  assert.strictEqual(completedFiles.length, 1, 'completed 디렉토리에 1개 파일 보관되어야 함');
  console.log('  PASS: Pending 항목 완료 마킹 및 completed 디렉토리 이동');
}

// 정리
fs.rmSync(tempCacheDir, { recursive: true, force: true });
console.log('[TEST] All Pending Queue Tests Passed Successfully.');
