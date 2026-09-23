/**
 * CI 환경 자동화 파이프라인 모듈
 * 자식 프로세스로 테스트를 구동하고 Pass/Fail을 자동 파싱하여 Notion DB로 동기화합니다.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/**
 * 테스트 출력 문자열에서 Pass/Fail 수치 정밀 추출
 */
function parseTestOutput(output) {
  let passCount = 0;
  let failCount = 0;
  let detected = false;

  // 1. Jest / Vitest 스타일: Tests: 5 passed, 1 failed, 6 total
  const jestPassMatch = output.match(/(\d+)\s+passed/i);
  const jestFailMatch = output.match(/(\d+)\s+failed/i);
  if (jestPassMatch) {
    passCount = parseInt(jestPassMatch[1], 10);
    detected = true;
  }
  if (jestFailMatch) {
    failCount = parseInt(jestFailMatch[1], 10);
    detected = true;
  }

  // 2. Mocha / Node test runner 스타일: ✔ 10 passed / ✖ 2 failed
  if (!detected) {
    const mochaPassMatch = output.match(/[✔√]\s*(\d+)\s*tests?\s*passed/i) || output.match(/(\d+)\s*passing/i);
    const mochaFailMatch = output.match(/[✖×]\s*(\d+)\s*tests?\s*failed/i) || output.match(/(\d+)\s*failing/i);
    if (mochaPassMatch) {
      passCount = parseInt(mochaPassMatch[1], 10);
      detected = true;
    }
    if (mochaFailMatch) {
      failCount = parseInt(mochaFailMatch[1], 10);
      detected = true;
    }
  }

  // 3. TAP 스타일: ok 1 - test / not ok 2 - test
  if (!detected) {
    const okMatches = output.match(/^ok\s+\d+/gm);
    const notOkMatches = output.match(/^not ok\s+\d+/gm);
    if (okMatches || notOkMatches) {
      passCount = okMatches ? okMatches.length : 0;
      failCount = notOkMatches ? notOkMatches.length : 0;
      detected = true;
    }
  }

  // 4. aleph-05-memory 자체 테스트 로그 스타일: [TEST_PASS] 또는 [PASS]
  if (!detected) {
    const customPass = (output.match(/\[PASS(?:ED)?\]/gi) || []).length;
    const customFail = (output.match(/\[FAIL(?:ED)?\]/gi) || []).length;
    if (customPass > 0 || customFail > 0) {
      passCount = customPass;
      failCount = customFail;
      detected = true;
    }
  }

  return { passCount, failCount, detected };
}

/**
 * CI 테스트 실행 및 푸시 파이프라인
 */
async function runCiPipeline(options = {}, syncEngine = null) {
  const rootDir = options.rootDir || process.cwd();
  const testCmd = options.testCmd || 'npm test';
  const handoverPath = path.join(rootDir, options.file || 'HANDOVER.md');

  console.log(`[CI] Executing test suite: "${testCmd}"...`);
  
  // OS별 쉘 실행 호환성 확보
  const isWin = process.platform === 'win32';
  const shellCmd = isWin ? 'cmd.exe' : '/bin/sh';
  const shellArgs = isWin ? ['/d', '/s', '/c', testCmd] : ['-c', testCmd];

  const testProc = spawnSync(shellCmd, shellArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  const fullOutput = `${testProc.stdout || ''}\n${testProc.stderr || ''}`;
  const exitCode = testProc.status !== null ? testProc.status : 1;

  let { passCount, failCount, detected } = parseTestOutput(fullOutput);

  if (!detected) {
    if (exitCode === 0) {
      passCount = 1;
      failCount = 0;
    } else {
      passCount = 0;
      failCount = 1;
    }
  }

  console.log(`[CI_RESULT] Tests completed. Exit Code: ${exitCode}, Passed: ${passCount}, Failed: ${failCount}`);

  // HANDOVER.md 존재 시 자동 푸시 실행
  const engine = syncEngine || require('./sync-engine');
  let pushResult = null;
  if (fs.existsSync(handoverPath)) {
    console.log(`[CI] Syncing handover to Notion DB...`);
    pushResult = await engine.executePush({
      file: handoverPath,
      phase: options.phase || (exitCode === 0 ? 'CI_PASS' : 'CI_FAIL'),
      pass: passCount,
      fail: failCount,
      tags: options.tags || `ci,exit-${exitCode}`
    });
  } else {
    console.warn(`[CI_WARN] Handover file ${handoverPath} not found. Skipping Notion push.`);
  }

  return {
    exitCode,
    passCount,
    failCount,
    output: fullOutput,
    pushResult
  };
}

module.exports = {
  parseTestOutput,
  runCiPipeline
};
