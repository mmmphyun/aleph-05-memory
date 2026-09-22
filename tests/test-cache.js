/**
 * 오프라인 로컬 캐시 단위 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  saveToCache,
  listCachedSessions,
  getLatestCachedSession
} = require('../lib/local-cache');

console.log('[TEST] Starting Local Cache Tests...');

const tempCacheDir = path.resolve(__dirname, 'out/test-cache-dir');

// 이전 잔여 디렉토리 정리
if (fs.existsSync(tempCacheDir)) {
  fs.rmSync(tempCacheDir, { recursive: true, force: true });
}

// 1. 세션 데이터 캐시 저장 검증 (T08 대비)
{
  const sessionData = {
    project: 'aleph-05-memory',
    phase: 'A_END',
    commitHash: '0123456789abcdef0123456789abcdef01234567',
    summary: '오프라인 캐시 테스트 세션',
    tags: ['offline', 'cache-test'],
    passCount: 5,
    failCount: 5,
    blocks: [{ object: 'block', type: 'paragraph' }],
    rawMarkdown: '# 1. 목표\n캐시 검증'
  };

  const savedPath = saveToCache(sessionData, tempCacheDir);
  assert.ok(fs.existsSync(savedPath), '캐시 JSON 파일이 생성되어야 함');

  const content = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.strictEqual(content.project, 'aleph-05-memory');
  assert.strictEqual(content.phase, 'A_END');
  assert.strictEqual(content.commitHash, '0123456789abcdef0123456789abcdef01234567');
  assert.strictEqual(content.passCount, 5);
  console.log('  PASS: 세션 데이터 JSON 스냅샷 저장 검증');
}

// 2. 캐시 목록 및 최신 세션 조회 검증
{
  const list = listCachedSessions(tempCacheDir);
  assert.strictEqual(list.length, 1, '캐시 항목 1개가 조회되어야 함');
  assert.strictEqual(list[0].phase, 'A_END');

  const latest = getLatestCachedSession(tempCacheDir);
  assert.ok(latest, '최신 캐시 세션이 반환되어야 함');
  assert.strictEqual(latest.project, 'aleph-05-memory');
  assert.strictEqual(latest.rawMarkdown, '# 1. 목표\n캐시 검증');
  console.log('  PASS: 캐시 목록 및 최신 세션 복원 조회 검증');
}

// 테스트 디렉토리 정리
if (fs.existsSync(tempCacheDir)) {
  fs.rmSync(tempCacheDir, { recursive: true, force: true });
}

console.log('[TEST] All Local Cache Tests Passed Successfully.');
