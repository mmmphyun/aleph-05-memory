/**
 * 세션 메모리 E2E 통합 테스트 (T01 ~ T10 파이프라인)
 */

const assert = require('node:assert');
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const cliPath = path.resolve(__dirname, '../bin/session-sync.js');
const mockServerPath = path.resolve(__dirname, 'mock-server.js');

function runCLI(args = '', env = {}) {
  try {
    const stdout = execSync(`node "${cliPath}" ${args}`, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
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

console.log('[TEST] Starting E2E Session Sync Pipeline Tests...');

// T02: 정상 7칸 인수인계 마크다운 파싱 검증
{
  const res = runCLI('push --file tests/fixtures/valid-handover.md --dry-run');
  assert.strictEqual(res.status, 0, '정상 7칸 인수인계 push --dry-run은 exit 0이어야 함');
  assert.ok(res.stdout.includes('[VALIDATION_SUCCESS] 7 required sections verified.'));
  console.log('  PASS [T02]: 정상 7칸 인수인계 드라이런 검증');
}

// T03: 필수 섹션 누락 탐지 검증
{
  const res = runCLI('push --file tests/fixtures/missing-section.md --dry-run');
  assert.strictEqual(res.status, 1, '필수 섹션 누락 시 exit 1이어야 함');
  assert.ok(res.stderr.includes("Missing required section: '건드리지 말 것'"));
  console.log('  PASS [T03]: 필수 섹션 누락 탐지 검증');
}

// T04: 2000자 블록 청크 분할 검증
{
  const res = runCLI('push --file tests/fixtures/overflow.md --dry-run --dump-blocks');
  assert.strictEqual(res.status, 0, 'overflow.md 파싱 성공해야 함');
  const jsonStart = res.stdout.indexOf('[\n');
  assert.ok(jsonStart !== -1, '블록 JSON 출력이 포함되어야 함');
  const blocks = JSON.parse(res.stdout.slice(jsonStart));
  for (const b of blocks) {
    const content = b[b.type];
    if (content && content.rich_text) {
      for (const rt of content.rich_text) {
        assert.ok(rt.text.content.length <= 2000, '청크 길이는 2000자 이하여야 함');
      }
    }
  }
  console.log('  PASS [T04]: 2000자 초과 블록 자동 분할 검증');
}

// T05: API 토큰 누락 안전 차단 검증
{
  const res = runCLI('push --file tests/fixtures/valid-handover.md', { NOTION_API_KEY: '' });
  assert.strictEqual(res.status, 1, 'API 키 누락 시 exit 1이어야 함');
  assert.ok(res.stderr.includes('[AUTH_ERROR] NOTION_API_KEY is not set in environment'));
  console.log('  PASS [T05]: API 키 누락 시 사전 차단 검증');
}

// T08: 서버 다운 시 로컬 캐시 폴백 검증
{
  const res = runCLI('push --file tests/fixtures/valid-handover.md --mock-port 59999 --api-key mock-key --fallback-cache');
  assert.strictEqual(res.status, 0, '캐시 폴백 옵션 시 exit 0이어야 함');
  assert.ok(res.stdout.includes('[FALLBACK] Cached to .sync_cache/'));
  assert.ok(fs.existsSync(path.resolve(process.cwd(), '.sync_cache')));
  console.log('  PASS [T08]: 네트워크 단절 시 로컬 캐시 자동 폴백 검증');
}

// T06, T09, T10: Mock HTTP 독립 자식 프로세스 연동 테스트
async function runSubprocessMockTests() {
  const mockProcess = spawn('node', [mockServerPath], { stdio: ['pipe', 'pipe', 'inherit'] });

  const mockPort = await new Promise((resolve, reject) => {
    mockProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line.startsWith('READY:')) {
        const port = parseInt(line.split(':')[1], 10);
        resolve(port);
      }
    });
    mockProcess.on('error', reject);
    setTimeout(() => reject(new Error('Mock server launch timeout')), 3000);
  });

  try {
    // T06: Mock 대상 Leaf 프로퍼티 전송 규격 검증
    {
      const res = runCLI(`push --file tests/fixtures/valid-handover.md --mock-port ${mockPort} --api-key mock-key --phase A_END --pass 5 --fail 5`);
      assert.strictEqual(res.status, 0, 'Mock 대상 push 성공해야 함');
      assert.ok(res.stdout.includes('[SYNC_SUCCESS] Page created in Notion. ID: mock-e2e-page-777'));
      console.log('  PASS [T06]: Mock 서버 대상 Leaf 프로퍼티 정상 적재 검증');
    }

    // T09: 목차 테이블 조회 (--list) 검증
    {
      const res = runCLI(`fetch --list --mock-port ${mockPort} --api-key mock-key`);
      assert.strictEqual(res.status, 0, 'fetch --list 성공해야 함');
      assert.ok(res.stdout.includes('Project'));
      assert.ok(res.stdout.includes('Phase'));
      assert.ok(res.stdout.includes('Commit'));
      assert.ok(res.stdout.includes('E2E Session Handover'));
      console.log('  PASS [T09]: 목차 인출 (--list) 경량성 및 테이블 출력 검증');
    }

    // T10: 최신 세션 본문 복원 E2E 검증
    {
      const outPath = path.resolve(__dirname, 'out/RESTORED.md');
      const res = runCLI(`fetch --latest --out tests/out/RESTORED.md --mock-port ${mockPort} --api-key mock-key`);
      assert.strictEqual(res.status, 0, 'fetch --latest 성공해야 함');
      assert.ok(fs.existsSync(outPath), 'RESTORED.md 파일이 생성되어야 함');
      const restoredContent = fs.readFileSync(outPath, 'utf8');
      assert.ok(restoredContent.includes('# 1. 목표'));
      assert.ok(restoredContent.includes('복원된 목표 본문입니다.'));
      console.log('  PASS [T10]: 최신 인수인계 마크다운 복원 E2E 검증');
    }

    // T11: 오프라인 아카이브 Failover 복원 CLI 검증
    {
      const archiveTestDir = path.resolve(__dirname, 'out/test-archives');
      if (!fs.existsSync(archiveTestDir)) fs.mkdirSync(archiveTestDir, { recursive: true });
      const archiveFilePath = path.join(archiveTestDir, '20260928_999999_TEST_FAILOVER.md');
      const dummyArchiveContent = [
        '---',
        'archived_at: 2026-09-28T00:00:00.000Z',
        'project: test-project',
        '---',
        '# 1. 목표',
        '',
        '아카이브에서 안전하게 복원된 오프라인 목표입니다.'
      ].join('\n');
      fs.writeFileSync(archiveFilePath, dummyArchiveContent, 'utf8');

      const { executeFetch } = require('../lib/sync-engine');
      const failoverOut = path.resolve(__dirname, 'out/FAILOVER_RESTORED.md');
      const fetchResult = await executeFetch({
        mockPort: 59998, // 미기동 포트로 네트워크 장애 유발
        apiKey: 'offline-key',
        out: 'tests/out/FAILOVER_RESTORED.md',
        failoverArchive: true,
        archiveDir: archiveTestDir
      });

      assert.strictEqual(fetchResult.success, true, 'Failover 복원은 성공해야 함');
      assert.strictEqual(fetchResult.source, 'archive', '복원 소스는 archive여야 함');
      assert.ok(fetchResult.filePath.includes('FAILOVER_RESTORED.md'), '출력 경로가 반환되어야 함');
      assert.ok(fs.existsSync(failoverOut), '복원된 파일이 디스크에 생성되어야 함');
      const fileData = fs.readFileSync(failoverOut, 'utf8');
      assert.ok(fileData.includes('아카이브에서 안전하게 복원된 오프라인 목표입니다.'));
      console.log('  PASS [T11]: 오프라인 네트워크 단절 시 로컬 아카이브 Failover 복원 검증');
    }
  } finally {
    mockProcess.kill();
  }
}

runSubprocessMockTests()
  .then(() => {
    console.log('[TEST] All E2E Pipeline Tests Passed Successfully.');
  })
  .catch((err) => {
    console.error(`[E2E_FAIL] ${err.message}`);
    process.exit(1);
  });
