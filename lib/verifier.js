/**
 * SWE-agent 방식 실행 기반 불변식 검증기 (Invariant Verifier)
 * 복원된 인수인계서와 실제 로컬 환경(Git Commit Graph, Working Tree, Test 실행) 간의
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
 * Git Graph 기반 상대적 드리프트 분석 (Ahead / Behind / Diverged 정량화)
 * 
 * @param {string} baseCommit - 인수인계서에 기록된 베이스 커밋
 * @param {string} headCommit - 로컬 저장소 실제 HEAD 커밋
 * @param {string} rootDir - 저장소 루트 경로
 * @returns {{type: 'MATCH'|'AHEAD'|'BEHIND'|'DIVERGED'|'UNKNOWN', ahead: number, behind: number, detail: string}}
 */
function getGitDrift(baseCommit, headCommit, rootDir = process.cwd()) {
  if (!baseCommit || !headCommit) {
    return { type: 'UNKNOWN', ahead: 0, behind: 0, detail: 'Base commit or HEAD missing' };
  }

  if (headCommit.startsWith(baseCommit) || baseCommit.startsWith(headCommit)) {
    return { type: 'MATCH', ahead: 0, behind: 0, detail: `Exact commit match (${headCommit.slice(0, 7)})` };
  }

  try {
    const countOutput = execSync(`git rev-list --left-right --count ${baseCommit}...${headCommit}`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const [behindStr, aheadStr] = countOutput.split(/\s+/);
    const behind = parseInt(behindStr, 10) || 0;
    const ahead = parseInt(aheadStr, 10) || 0;

    if (behind === 0 && ahead > 0) {
      return {
        type: 'AHEAD',
        ahead,
        behind,
        detail: `HEAD is ahead of base commit by ${ahead} commit(s) (Fast-forward)`
      };
    } else if (ahead === 0 && behind > 0) {
      return {
        type: 'BEHIND',
        ahead,
        behind,
        detail: `HEAD is behind base commit by ${behind} commit(s) (Pull required)`
      };
    } else if (ahead > 0 && behind > 0) {
      return {
        type: 'DIVERGED',
        ahead,
        behind,
        detail: `HEAD and base commit have diverged (+${ahead}, -${behind} commits)`
      };
    }

    return { type: 'MATCH', ahead: 0, behind: 0, detail: 'No commit delta' };
  } catch (_) {
    // shallow clone이거나 base commit 객체가 로컬 DB에 없는 경우
    return {
      type: 'UNKNOWN',
      ahead: 0,
      behind: 0,
      detail: `Base commit ${baseCommit.slice(0, 7)} not found in local git history`
    };
  }
}

/**
 * 불변식 전수 검증 실행
 * 
 * @param {Object} options
 * @param {string} [options.file] - 대상 인수인계서 경로
 * @param {boolean} [options.runTest=false] - 실제 테스트 스위트 실행 여부
 * @param {boolean} [options.strict=false] - 엄격 모드 (드리프트나 Dirty 트리 감지 시 실패 처리)
 * @param {number} [options.timeout=25000] - 테스트 타임아웃
 * @param {string} [options.cwd] - 작업 디렉토리
 */
function verifySessionInvariants(options = {}) {
  const rootDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const handoverPath = options.file ? path.resolve(rootDir, options.file) : DEFAULT_HANDOVER_PATH;
  const runTest = Boolean(options.runTest);
  const strict = Boolean(options.strict);
  const timeoutMs = options.timeout ? Number(options.timeout) : 25000;

  const report = {
    isValid: true,
    hasDrift: false,
    isDirty: false,
    testPassed: null,
    testErrorOutput: null,
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

  // 2. Git Commit Drift 검증 (Git Graph 기반)
  const gitState = getGitState(rootDir);
  report.details.gitState = gitState;

  if (gitState.isGitRepo) {
    if (recordedBaseCommit && gitState.headCommit) {
      const drift = getGitDrift(recordedBaseCommit, gitState.headCommit, rootDir);
      report.details.drift = drift;

      if (drift.type === 'MATCH') {
        report.checks.push({
          name: 'Git Commit Consistency',
          status: 'PASS',
          detail: `HEAD (${gitState.headCommit.slice(0, 7)}) matches handover base commit (${recordedBaseCommit.slice(0, 7)})`
        });
      } else {
        report.hasDrift = true;
        const status = strict ? 'FAIL' : 'WARN';
        if (strict) report.isValid = false;

        report.checks.push({
          name: 'Git Commit Consistency',
          status,
          detail: `DRIFT [${drift.type}]: ${drift.detail} (Base: ${recordedBaseCommit.slice(0, 7)}, HEAD: ${gitState.headCommit.slice(0, 7)})`
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
      const status = strict ? 'FAIL' : 'WARN';
      if (strict) report.isValid = false;

      report.checks.push({
        name: 'Working Tree Cleanliness',
        status,
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

  // 4. 테스트 재현성 검증 (--run-test 지정 시)
  if (runTest && recordedTestCmd) {
    try {
      execSync(recordedTestCmd, {
        cwd: rootDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8'
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
      const rawError = testErr.stderr || testErr.stdout || testErr.message || '';
      // 상세 에러 트레이스 테일 캡처
      report.testErrorOutput = rawError.slice(-1500).trim();

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

  if (report.testErrorOutput) {
    lines.push(`--------------------------------------------------------------------------------`);
    lines.push(`  TEST ERROR OUTPUT (TAIL):`);
    lines.push(report.testErrorOutput);
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
    if (!report.isValid) process.exit(1);
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
  getGitDrift,
  verifySessionInvariants,
  formatVerifyReport,
  executeVerify
};
