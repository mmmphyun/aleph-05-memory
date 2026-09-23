/**
 * doctor 모듈 단위 및 통합 테스트
 */

const assert = require('node:assert');
const http = require('node:http');
const { isValidNotionId, runDoctor, pingNotionApi } = require('../lib/doctor');

console.log('[TEST] Starting Doctor Tests...');

// 1. Notion ID 규격 검증 헬퍼
{
  assert.strictEqual(isValidNotionId('8a4581b40ffae6b0feedb6f2e7728a45'), true);
  assert.strictEqual(isValidNotionId('8a4581b4-0ffa-e6b0-feed-b6f2e7728a45'), true);
  assert.strictEqual(isValidNotionId('invalid-uuid-too-short'), false);
  assert.strictEqual(isValidNotionId(''), false);
  assert.strictEqual(isValidNotionId(null), false);
  console.log('  PASS: UUID 및 32자리 Hex 검증 무결성');
}

// 2. 정상 환경(Mock) 전수 통과 검증
async function testHealthyEnvironment() {
  const healthyEnv = {
    NOTION_API_KEY: 'secret_1234567890abcdef1234567890abcdef',
    NOTION_DATABASE_ID: '8a4581b4-0ffa-e6b0-feed-b6f2e7728a45',
    NOTION_PROJECTS_DATABASE_ID: '12345678-1234-1234-1234-123456789abc'
  };

  const res = await runDoctor({
    nodeVersion: 'v20.10.0',
    envOverride: healthyEnv,
    execSync: (cmd) => {
      if (cmd.startsWith('git')) return 'git version 2.44.0';
      if (cmd.includes('session-sync')) return 'C:\\mock\\session-sync.cmd';
      return '';
    },
    mockPing: () => ({ status: 'PASS', code: 200, message: 'HTTP 200 OK (Authenticated as TestBot)' })
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.summary.fail, 0);
  assert.strictEqual(res.summary.hasBlockingFailure, false);
  console.log('  PASS: 모든 요구조건 충족 시 정상(PASS) 판정 검증');
}

// 3. 다중 결함 시 중단 없는 전수 검사(Non-blocking All-in-one) 검증
async function testNonBlockingAllInOne() {
  const brokenEnv = {
    NOTION_API_KEY: 'invalid_prefix_token', // FAIL: prefix
    NOTION_DATABASE_ID: 'invalid_id_not_uuid', // FAIL: format
    NOTION_PROJECTS_DATABASE_ID: 'bad_id' // FAIL: format
  };

  const res = await runDoctor({
    nodeVersion: 'v18.15.0', // FAIL: < v20
    envOverride: brokenEnv,
    execSync: () => {
      throw new Error('command not found'); // FAIL: git
    },
    mockPing: () => ({ status: 'FAIL', code: 401, message: 'HTTP 401 Unauthorized' })
  });

  // 즉각 중단되지 않고 모든 항목이 끝까지 수집되었는지 확인
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.summary.hasBlockingFailure, true);
  assert.ok(res.checks.length >= 7, '모든 진단 항목(7개 이상)이 전수 수집되어야 함');

  const failedChecks = res.checks.filter((c) => c.status === 'FAIL');
  assert.ok(failedChecks.some((c) => c.id === 'NODE_VERSION'), 'Node 버전 에러 수집');
  assert.ok(failedChecks.some((c) => c.id === 'GIT_VCS'), 'Git 부재 에러 수집');
  assert.ok(failedChecks.some((c) => c.id === 'NOTION_API_KEY'), 'API 토큰 포맷 에러 수집');
  assert.ok(failedChecks.some((c) => c.id === 'NOTION_DATABASE_ID'), 'DB ID 규격 에러 수집');
  assert.ok(failedChecks.some((c) => c.id === 'NOTION_PROJECTS_DB'), '프로젝트 DB 규격 에러 수집');
  assert.ok(failedChecks.some((c) => c.id === 'NOTION_API_PING'), 'API 핑 에러 수집');

  console.log('  PASS: 다중 결함 발생 시 즉각 중단 없이 끝까지 전수 수집(Non-blocking) 검증');
}

// 4. Mock HTTP 서버 기반 Notion Ping 통신 검증
async function testHttpPingMockServer() {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'];
    if (auth === 'Bearer secret_valid_key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'IntegrationBot', bot: {} }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const pingUrl = `http://127.0.0.1:${port}/v1/users/me`;

  try {
    // 4-1. 200 OK 테스트
    const okRes = await pingNotionApi('secret_valid_key', { pingUrl });
    assert.strictEqual(okRes.status, 'PASS');
    assert.strictEqual(okRes.code, 200);
    assert.ok(okRes.message.includes('IntegrationBot'));

    // 4-2. 401 Unauthorized 테스트
    const unauthRes = await pingNotionApi('secret_wrong_key', { pingUrl });
    assert.strictEqual(unauthRes.status, 'FAIL');
    assert.strictEqual(unauthRes.code, 401);
  } finally {
    server.close();
  }

  console.log('  PASS: Mock HTTP 서버 연동 Ping 정상(200) 및 인증 실패(401) 판정 검증');
}

async function main() {
  await testHealthyEnvironment();
  await testNonBlockingAllInOne();
  await testHttpPingMockServer();
  console.log('[TEST] All Doctor Tests Passed Successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
