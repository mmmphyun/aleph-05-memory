/**
 * Git Hook 설치 및 Fail-Open 단위 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { installHook, executeHook } = require('../lib/git-hook');

console.log('[TEST] Starting Git Hook Tests...');

const tempRepoDir = path.resolve(__dirname, 'out/test-repo');
if (fs.existsSync(tempRepoDir)) {
  fs.rmSync(tempRepoDir, { recursive: true, force: true });
}
fs.mkdirSync(path.join(tempRepoDir, '.git'), { recursive: true });

// 1. 훅 설치 및 백업 테스트
{
  const hookPath = installHook(tempRepoDir);
  assert.ok(fs.existsSync(hookPath), 'pre-push 훅 파일이 생성되어야 함');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert.ok(content.includes('hook exec'), '훅 내용에 hook exec 포함되어야 함');

  // 재설치 시 백업 파일 생성 확인
  installHook(tempRepoDir);
  const backupPath = path.join(tempRepoDir, '.git/hooks/pre-push.bak');
  assert.ok(fs.existsSync(backupPath), '이전 훅 백업 파일이 생성되어야 함');
  console.log('  PASS: pre-push 훅 설치 및 기존 훅 백업 메커니즘');
}

// 2. HANDOVER.md 누락 시 Skip 처리 확인
{
  const promise = executeHook({ rootDir: tempRepoDir, file: 'NON_EXISTENT.md' });
  promise.then((res) => {
    assert.strictEqual(res.skipped, true, '핸드오버 파일 부재 시 정상 skip되어야 함');
    console.log('  PASS: 인수인계 파일 부재 시 안전한 스킵 처리');
  });
}

console.log('[TEST] All Git Hook Tests Passed Successfully.');
