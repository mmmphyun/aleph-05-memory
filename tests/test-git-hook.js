/**
 * Git Hook 설치, Worktree 호환성 및 Fail-Open 단위 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { installHook, executeHook, resolveGitHooksDir, HOOK_TEMPLATE } = require('../lib/git-hook');

console.log('[TEST] Starting Git Hook Tests...');

const testBaseDir = path.resolve(__dirname, 'out');
const tempRepoDir = path.join(testBaseDir, 'test-repo');
const tempWorktreeDir = path.join(testBaseDir, 'test-worktree');
const tempNonGitDir = path.join(testBaseDir, 'test-non-git');

// 0. 테스트 디렉토리 초기화
function cleanDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_err) {
      // Windows 파일 잠금 대비
    }
  }
}

cleanDir(tempRepoDir);
cleanDir(tempWorktreeDir);
cleanDir(tempNonGitDir);

fs.mkdirSync(path.join(tempRepoDir, '.git'), { recursive: true });

async function runTests() {
  // 1. 훅 설치, 템플릿 및 백업 테스트
  {
    assert.ok(HOOK_TEMPLATE.includes('session-sync hook exec "$@"'), '전역 바이너리 호출 템플릿이어야 함');
    assert.ok(!HOOK_TEMPLATE.includes('./bin/session-sync.js'), '상대 경로 호출이 제거되어야 함');

    const hookPath = installHook(tempRepoDir);
    assert.ok(fs.existsSync(hookPath), 'pre-push 훅 파일이 생성되어야 함');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('session-sync hook exec "$@"'), '훅 내용에 session-sync hook exec 포함되어야 함');

    // 재설치 시 백업 파일 생성 확인
    installHook(tempRepoDir);
    const backupPath = path.join(tempRepoDir, '.git/hooks/pre-push.bak');
    assert.ok(fs.existsSync(backupPath), '이전 훅 백업 파일이 생성되어야 함');
    console.log('  PASS: pre-push 훅 설치 및 기존 훅 백업 메커니즘');
  }

  // 2. HANDOVER.md 누락 시 Skip 처리 확인
  {
    const res = await executeHook({ rootDir: tempRepoDir, file: 'NON_EXISTENT.md' });
    assert.strictEqual(res.skipped, true, '핸드오버 파일 부재 시 정상 skip되어야 함');
    console.log('  PASS: 인수인계 파일 부재 시 안전한 스킵 처리');
  }

  // 3. Git Worktree 호환성 E2E 테스트 (실제 git worktree 생성)
  {
    cleanDir(tempRepoDir);
    cleanDir(tempWorktreeDir);
    fs.mkdirSync(tempRepoDir, { recursive: true });

    // 실제 Git 저장소 초기화 및 첫 커밋
    execSync('git init -b main', { cwd: tempRepoDir, stdio: 'pipe' });
    execSync('git config user.name "TestUser"', { cwd: tempRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tempRepoDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial commit"', { cwd: tempRepoDir, stdio: 'pipe' });

    // Worktree 추가
    execSync(`git worktree add "${tempWorktreeDir}" -b feature-worktree`, { cwd: tempRepoDir, stdio: 'pipe' });

    // Worktree 내 .git 파일 여부 확인
    const worktreeGitFile = path.join(tempWorktreeDir, '.git');
    assert.ok(fs.existsSync(worktreeGitFile), 'Worktree 내 .git 항목이 존재해야 함');
    assert.ok(fs.statSync(worktreeGitFile).isFile(), 'Worktree 내 .git은 디렉토리가 아닌 파일이어야 함');

    // Worktree 디렉토리 대상 훅 디렉토리 추출 및 설치
    const resolvedHooks = resolveGitHooksDir(tempWorktreeDir);
    assert.ok(resolvedHooks.includes('hooks'), '정상적인 hooks 경로를 반환해야 함');

    const hookPath = installHook(tempWorktreeDir);
    assert.ok(fs.existsSync(hookPath), 'Worktree 훅 경로에 pre-push가 생성되어야 함');
    const content = fs.readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('session-sync hook exec'), 'Worktree 훅 파일 내용 검증');
    console.log('  PASS: Git Worktree 환경 내 동적 훅 디렉토리 추출 및 설치 E2E 검증');

    // 정리
    try {
      execSync(`git worktree remove --force "${tempWorktreeDir}"`, { cwd: tempRepoDir, stdio: 'pipe' });
    } catch (_cleanupErr) {
      // ignore
    }
  }

  // 4. Git 부재 디렉토리 로컬 백업 테스트
  {
    cleanDir(tempNonGitDir);
    fs.mkdirSync(tempNonGitDir, { recursive: true });

    const resolvedHooks = resolveGitHooksDir(tempNonGitDir);
    assert.strictEqual(
      resolvedHooks,
      path.join(tempNonGitDir, '.session-memory', 'hooks'),
      'Git 부재 시 .session-memory/hooks 로컬 경로로 fallback 되어야 함'
    );

    const hookPath = installHook(tempNonGitDir);
    assert.ok(fs.existsSync(hookPath), '로컬 백업 경로에 pre-push 파일이 생성되어야 함');
    assert.ok(hookPath.includes(path.join('.session-memory', 'hooks')), '로컬 백업 디렉토리 경로 검증');
    console.log('  PASS: Git 부재 환경 크래시 방지 및 .session-memory 로컬 백업 검증');
  }

  console.log('[TEST] All Git Hook Tests Passed Successfully.');
}

runTests().catch((err) => {
  console.error(`[TEST_FAIL] ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
