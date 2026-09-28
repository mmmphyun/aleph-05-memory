/**
 * SWE-agent 방식 실행 기반 불변식 검증기 단위 및 통합 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractBaseCommit,
  extractTestCommand,
  getGitState,
  verifySessionInvariants,
  formatVerifyReport
} = require('../lib/verifier');

console.log('[TEST] Starting Invariant Verifier Tests...');

// 1. 베이스 커밋 추출 테스트
{
  const statusContent1 = `- 베이스 커밋: \`029d1d840cb1bef8f381890c24b46355706e109f\`\n- 상태: 정상`;
  assert.strictEqual(extractBaseCommit(statusContent1), '029d1d840cb1bef8f381890c24b46355706e109f');

  const statusContent2 = `Base commit: 1111111\nother details`;
  assert.strictEqual(extractBaseCommit(statusContent2), '1111111');

  const statusContentNone = `커밋 정보 없음`;
  assert.strictEqual(extractBaseCommit(statusContentNone), null);
  console.log('  PASS: 베이스 커밋 해시 정규식 추출 검증');
}

// 2. 테스트 명령어 추출 테스트
{
  const cmdContent = `런타임: Node.js
\`\`\`powershell
# 단위 테스트 실행
npm test
\`\`\``;
  const cmd = extractTestCommand(cmdContent);
  assert.strictEqual(cmd, 'npm test');

  const cmdNone = `실행할 명령어 없음`;
  assert.strictEqual(extractTestCommand(cmdNone), null);
  console.log('  PASS: 마크다운 코드블록 내 테스트 커맨드 자동 추출 검증');
}

// 3. Git 상태 조회 테스트
{
  const gitState = getGitState(process.cwd());
  assert.strictEqual(gitState.isGitRepo, true);
  assert.ok(typeof gitState.headCommit === 'string' && gitState.headCommit.length >= 7);
  assert.ok(typeof gitState.isClean === 'boolean');
  console.log('  PASS: Git 저장소 HEAD 커밋 및 작업 트리 상태 조회 검증');
}

// 4. 불변식 검증 파이프라인 E2E 테스트
{
  const tempDir = path.resolve(process.cwd(), 'tests', 'out', 'test-verifier');
  fs.mkdirSync(tempDir, { recursive: true });

  const currentGit = getGitState(process.cwd());

  // 4.1 일치하는 인수인계서 작성
  const matchingHandover = `# 1. 목표
불변식 검증 테스트

# 2. 현재 상태
- 베이스 커밋: \`${currentGit.headCommit}\`

# 3. 실행 명령
\`\`\`powershell
node -e "process.exit(0)"
\`\`\`

# 4. 통과 검사
통과

# 5. 남은 문제
없음

# 6. 다음 행동
- 대상 파일: \`lib/verifier.js\`

# 7. 건드리지 말 것
- \`tests/\`
`;

  const matchingPath = path.join(tempDir, 'HANDOVER_MATCH.md');
  fs.writeFileSync(matchingPath, matchingHandover, 'utf8');

  const matchReport = verifySessionInvariants({
    cwd: process.cwd(),
    file: matchingPath,
    runTest: true
  });

  assert.strictEqual(matchReport.isValid, true);
  assert.strictEqual(matchReport.hasDrift, false);
  assert.strictEqual(matchReport.testPassed, true);
  console.log('  PASS: Git HEAD 및 테스트 통과 정상(MATCH) 상태 불변식 검증');

  // 4.2 드리프트 인수인계서 작성 (과거 해시)
  const driftHandover = matchingHandover.replace(currentGit.headCommit, '0000000000000000000000000000000000000000');
  const driftPath = path.join(tempDir, 'HANDOVER_DRIFT.md');
  fs.writeFileSync(driftPath, driftHandover, 'utf8');

  const driftReport = verifySessionInvariants({
    cwd: process.cwd(),
    file: driftPath,
    runTest: false
  });

  assert.strictEqual(driftReport.hasDrift, true);
  assert.strictEqual(driftReport.checks.some((c) => c.status === 'WARN'), true);
  console.log('  PASS: Git 커밋 불일치(DRIFT_DETECTED) 경고 감지 검증');

  // 4.3 실패하는 테스트 명령어 포함 인수인계서 (stderr 테일 캡처 검증)
  const failTestHandover = matchingHandover.replace('process.exit(0)', 'console.error("CRITICAL_TEST_FAILURE_DETAIL"); process.exit(1)');
  const failTestPath = path.join(tempDir, 'HANDOVER_FAIL.md');
  fs.writeFileSync(failTestPath, failTestHandover, 'utf8');

  const failReport = verifySessionInvariants({
    cwd: process.cwd(),
    file: failTestPath,
    runTest: true
  });

  assert.strictEqual(failReport.isValid, false);
  assert.strictEqual(failReport.testPassed, false);
  assert.strictEqual(failReport.checks.some((c) => c.status === 'FAIL'), true);
  assert.ok(failReport.testErrorOutput && failReport.testErrorOutput.includes('CRITICAL_TEST_FAILURE_DETAIL'), '실패한 테스트의 stderr 출력이 캡처되어야 합니다.');
  console.log('  PASS: 테스트 실패 시 불변식 위반(FAIL) 하드 감지 및 Stderr 테일 캡처 검증');

  // 4.4 Strict 모드 동작 검증
  const strictReport = verifySessionInvariants({
    cwd: process.cwd(),
    file: driftPath,
    runTest: false,
    strict: true
  });
  assert.strictEqual(strictReport.isValid, false, 'Strict 모드에서는 드리프트 감지 시 isValid가 false여야 합니다.');
  assert.strictEqual(strictReport.checks.some((c) => c.status === 'FAIL'), true);
  console.log('  PASS: --strict 모드 지정 시 드리프트 하드 차단(FAIL) 검증');

  // 4.5 Git Graph getGitDrift 함수 검증
  const { getGitDrift } = require('../lib/verifier');
  const exactDrift = getGitDrift(currentGit.headCommit, currentGit.headCommit, process.cwd());
  assert.strictEqual(exactDrift.type, 'MATCH');
  console.log('  PASS: getGitDrift 함수 동일 커밋 MATCH 판정 검증');

  // 4.6 리포트 포맷팅 검증
  const formatted = formatVerifyReport(failReport);
  assert.ok(formatted.includes('SESSION-SYNC INVARIANT VERIFIER REPORT'));
  assert.ok(formatted.includes('TEST ERROR OUTPUT (TAIL):'));
  assert.ok(formatted.includes('CRITICAL_TEST_FAILURE_DETAIL'));
  console.log('  PASS: 진단 리포트 터미널 렌더링 및 에러 트레이스 출력 검증');
}

console.log('[TEST] All Invariant Verifier Tests Passed Successfully.');
