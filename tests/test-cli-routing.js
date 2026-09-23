/**
 * CLI 인자 파싱 및 라우팅 단위 테스트
 */

const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const cliPath = path.resolve(__dirname, '../bin/session-sync.js');

function runCLI(args = '', options = {}) {
  try {
    const stdout = execSync(`node "${cliPath}" ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      status: err.status,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim()
    };
  }
}

console.log('[TEST] Starting CLI Routing Tests...');

// 1. 인자 없을 때: exit 1 및 stderr에 사용법 포함 확인 (T01 검증 기반)
{
  const res = runCLI('');
  assert.strictEqual(res.status, 1, '인자 없을 시 exit 1이어야 함');
  assert.match(res.stderr, /Usage: session-sync <init\|push\|fetch> \[options\]/, 'stderr에 사용법 안내 포함되어야 함');
  console.log('  PASS: 인자 없을 시 비정상 종료 및 사용법 안내 출력');
}

// 2. --help 플래그: exit 0 및 stdout 도움말 출력 확인
{
  const res = runCLI('--help');
  assert.strictEqual(res.status, 0, '--help 시 exit 0이어야 함');
  assert.match(res.stdout, /Commands:[\s\S]*init[\s\S]*push[\s\S]*fetch/, 'stdout에 서브커맨드 목록 포함되어야 함');
  console.log('  PASS: --help 옵션 정상 처리');
}

// 3. 잘못된 서브커맨드: exit 1 및 stderr 에러 출력 확인
{
  const res = runCLI('invalid-cmd');
  assert.strictEqual(res.status, 1, '잘못된 서브커맨드 입력 시 exit 1이어야 함');
  assert.match(res.stderr, /Error: Unknown command 'invalid-cmd'/, 'stderr에 미지원 커맨드 에러 포함되어야 함');
  console.log('  PASS: 알 수 없는 서브커맨드 예외 처리');
}

// 4. scaffold --help 플래그 검증
{
  const res = runCLI('scaffold --help');
  assert.strictEqual(res.status, 0, 'scaffold --help 시 exit 0이어야 함');
  assert.match(res.stdout, /Usage: session-sync scaffold \[--out <PATH>\] \[--force\] \[--stdout\]/, 'scaffold 도움말 형식 검증');
  console.log('  PASS: scaffold --help 옵션 정상 처리');
}

// 5. doctor --help 플래그 검증
{
  const res = runCLI('doctor --help');
  assert.strictEqual(res.status, 0, 'doctor --help 시 exit 0이어야 함');
  assert.match(res.stdout, /Usage: session-sync doctor \[--silent\] \[--timeout <MS>\]/, 'doctor 도움말 형식 검증');
  console.log('  PASS: doctor --help 옵션 정상 처리');
}

// 6. search --help 플래그 검증
{
  const res = runCLI('search --help');
  assert.strictEqual(res.status, 0, 'search --help 시 exit 0이어야 함');
  assert.match(res.stdout, /Usage: session-sync search --query <TEXT>/, 'search 도움말 형식 검증');
  console.log('  PASS: search --help 옵션 정상 처리');
}

// 7. verify --help 플래그 검증
{
  const res = runCLI('verify --help');
  assert.strictEqual(res.status, 0, 'verify --help 시 exit 0이어야 함');
  assert.match(res.stdout, /Usage: session-sync verify/, 'verify 도움말 형식 검증');
  console.log('  PASS: verify --help 옵션 정상 처리');
}

console.log('[TEST] All CLI Routing Tests Passed Successfully.');
