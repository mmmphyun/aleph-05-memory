/**
 * SWE-agent 방식 실행 기반 불변식 검증기 (Invariant Verifier)
 * 복원된 인수인계서와 실제 로컬 환경(Git Commit, Working Tree, Test 실행) 간의
 * 정합성을 0/1 비트로 대조하여 드리프트(Drift)를 실측 감지합니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { extractSections } = require('./diff-engine');

const DEFAULT_HANDOVER_PATH = path.resolve(process.cwd(), 'HANDOVER.md');

/**
 * 인수인계서 본문에서 베이스 커밋 해시 추출
 */
function extractBaseCommit(statusSectionContent) {
  if (!statusSectionContent) return null;
  const match = statusSectionContent.match(/(?:베이스\s*커밋|base\s*commit)[:：]\s*[`']?([0-9a-f]{7,40})[`']?/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 실행 명령 섹션에서 테스트 명령어 추출
 */
function extractTestCommand(commandSectionContent) {
  if (!commandSectionContent) return null;
  // 코드 블록(``` ... ```) 내부 탐색
  const codeBlockMatch = commandSectionContent.match(/```(?:powershell|bash|sh|cmd)?\r?\n([\s\S]*?)```/i);
  const targetText = codeBlockMatch ? codeBlockMatch[1] : commandSectionContent;

  const lines = targetText.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (line.startsWith('#') || !line) continue;
    if (/(?:npm\s+test|node\s+|pytest|cargo\s+test|mvn\s+test|gradlew|python\s+)/i.test(line)) {
      return line;
    }
  }
  return null;
}

/**
 * 현재 Git 저장소의 HEAD 커밋 해시 및 Clean 상태 확인
 */
function getGitState(rootDir = process.cwd()) {
  try {
    const headCommit = execSync('git rev-parse HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().toLowerCase();

    const statusOutput = execSync('git status -s', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const dirtyFiles = statusOutput
      ? statusOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];

    return {
      isGitRepo: true,
      headCommit,
      isClean: dirtyFiles.length === 0,
      dirtyFiles
    };
  } catch (err) {
    return {
      isGitRepo: false,
      headCommit: null,
      isClean: true,
      dirtyFiles: []
    };
  }
}

/**
 * 불변식 전수 검증 실행
 */
function verifySessionInvariants(options = {}) {
  const rootDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const handoverPath = options.file ? path.resolve(rootDir, options.file) : DEFAULT_HANDOVER_PATH;
  const runTest = Boolean(options.runTest);
  const timeoutMs = options.timeout ? Number(options.timeout) : 15000;

  const report = {
    isValid: true,
    hasDrift: false,
    isDirty: false,
    testPassed: null,
    checks: [],
    details: {}
  };

  // 1. 인수인계서 파일 존재 여부 검사
  if (!fs.existsSync(handoverPath)) {
    report.isValid = false;
    report.checks.push({
      name: 'Handover File Existence',
      status: 'FAIL',
      detail: `Handover file not found: ${handoverPath}`
    });
    return report;
  }

  const rawMarkdown = fs.readFileSync(handoverPath, 'utf8');
  const sections = extractSections(rawMarkdown);
  const recordedBaseCommit = extractBaseCommit(sections['현재 상태']);
  const recordedTestCmd = extractTestCommand(sections['실행 명령']);

  report.details.handoverPath = handoverPath;
  report.details.recordedBaseCommit = recordedBaseCommit;
  report.details.recordedTestCmd = recordedTestCmd;

  // 2. Git Commit Drift 검증
  const gitState = getGitState(rootDir);
  report.details.gitState = gitState;

  if (gitState.isGitRepo) {
    if (recordedBaseCommit && gitState.headCommit) {
      const match = gitState.headCommit.startsWith(recordedBaseCommit) || recordedBaseCommit.startsWith(gitState.headCommit);
      if (match) {
        report.checks.push({
          name: 'Git Commit Consistency',
          status: 'PASS',
          detail: `HEAD (${gitState.headCommit.slice(0, 7)}) matches handover base commit (${recordedBaseCommit.slice(0, 7)})`
        });
      } else {
        report.hasDrift = true;
        report.checks.push({
          name: 'Git Commit Consistency',
          status: 'WARN',
          detail: `DRIFT DETECTED: HEAD is at ${gitState.headCommit.slice(0, 7)}, but handover recorded ${recordedBaseCommit.slice(0, 7)}`
        });
      }
    } else {
      report.checks.push({
        name: 'Git Commit Consistency',
        status: 'SKIP',
        detail: 'No base commit hash recorded in section [현재 상태]'
      });
    }

    // 3. 작업 트리 Cleanliness 검증
    if (gitState.isClean) {
      report.checks.push({
        name: 'Working Tree Cleanliness',
        status: 'PASS',
        detail: 'Working tree is clean'
      });
    } else {
      report.isDirty = true;
      report.checks.push({
        name: 'Working Tree Cleanliness',
        status: 'WARN',
        detail: `DIRTY TREE: ${gitState.dirtyFiles.length} uncommitted file(s) detected (${gitState.dirtyFiles.slice(0, 3).join(', ')})`
      });
    }
  } else {
    report.checks.push({
      name: 'Git Repository Status',
      status: 'SKIP',
      detail: 'Not inside a Git repository'
    });
  }

  // 4. 테스트 재현성 검증 (--run-test 지정 시 또는 강제 시)
  if (runTest && recordedTestCmd) {
    try {
      execSync(recordedTestCmd, {
        cwd: rootDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      report.testPassed = true;
      report.checks.push({
        name: 'Test Reproducibility',
        status: 'PASS',
        detail: `Test command passed: ${recordedTestCmd}`
      });
    } catch (testErr) {
      report.testPassed = false;
      report.isValid = false;
      report.checks.push({
        name: 'Test Reproducibility',
        status: 'FAIL',
        detail: `Test command failed (${recordedTestCmd}): ${testErr.message.slice(0, 100)}`
      });
    }
  } else if (runTest && !recordedTestCmd) {
    report.checks.push({
      name: 'Test Reproducibility',
      status: 'SKIP',
      detail: 'No test command detected in section [실행 명령]'
    });
  } else {
    report.checks.push({
      name: 'Test Reproducibility',
      status: 'SKIP',
      detail: 'Fast check mode (use --run-test to execute test suite)'
    });
  }

  return report;
}

/**
 * 터미널용 진단 리포트 출력 포맷팅
 */
function formatVerifyReport(report) {
  const lines = [
    `================================================================================`,
    `  SESSION-SYNC INVARIANT VERIFIER REPORT`,
    `================================================================================`
  ];

  for (const check of report.checks) {
    const tag = `[${check.status.padEnd(4)}]`;
    lines.push(`${tag}   ${check.name.padEnd(25)} : ${check.detail}`);
  }

  lines.push(`================================================================================`);

  if (!report.isValid) {
    lines.push(`VERIFY FAILED: One or more critical invariants failed. Action required before proceeding.`);
  } else if (report.hasDrift || report.isDirty) {
    lines.push(`VERIFY WARNING: Minor drift detected. Review changes before proceeding.`);
  } else {
    lines.push(`VERIFY PASSED: All invariants verified (0 drift, clean state). Ready for next task.`);
  }

  lines.push(`================================================================================`);
  return lines.join('\n');
}

/**
 * CLI verify 명령 실행기
 */
function executeVerify(options = {}) {
  const report = verifySessionInvariants(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const output = formatVerifyReport(report);
  if (!options.silent) {
    console.log(output);
  }

  if (!report.isValid) {
    process.exit(1);
  }

  return report;
}

module.exports = {
  DEFAULT_HANDOVER_PATH,
  extractBaseCommit,
  extractTestCommand,
  getGitState,
  verifySessionInvariants,
  formatVerifyReport,
  executeVerify
};
