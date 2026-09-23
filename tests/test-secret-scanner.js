/**
 * Gitleaks 기반 시크릿 스캐너 단위 테스트
 */

const assert = require('node:assert');
const { scanSecrets, isAllowed } = require('../lib/secret-scanner');
const { parseHandoverMarkdown } = require('../lib/markdown-parser');

console.log('[TEST] Starting Gitleaks Secret Scanner Tests...');

// 1. Notion API 토큰 탐지 검증 (레거시 secret_ 및 최신 ntn_)
{
  const text1 = '실행 시 NOTION_API_KEY="secret_0123456789abcdef0123456789abcdef" 를 설정하세요.';
  const leaks1 = scanSecrets(text1);
  assert.ok(leaks1.length >= 1, 'Notion secret_ 토큰 감지되어야 함');
  assert.ok(leaks1.some((l) => l.ruleId === 'notion-api-token'), 'notion-api-token 룰 매칭 확인');

  const text2 = '최신 토큰 ntn_1234567890abcdef1234567890abcdef1234 입니다.';
  const leaks2 = scanSecrets(text2);
  assert.strictEqual(leaks2.length, 1, 'Notion ntn_ 토큰 감지되어야 함');
  assert.strictEqual(leaks2[0].ruleId, 'notion-api-token');
  console.log('  PASS: Notion API 토큰(secret_ 및 ntn_) 누출 정밀 감지');
}

// 2. GitHub PAT 및 AWS Key 탐지 검증
{
  const githubText = '토큰: ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  const ghLeaks = scanSecrets(githubText);
  assert.strictEqual(ghLeaks.length, 1);
  assert.strictEqual(ghLeaks[0].ruleId, 'github-pat');

  const awsText = 'AWS Key는 AKIAIOSFODNN7EXAMPLE 입니다.';
  const awsLeaks = scanSecrets(awsText);
  assert.strictEqual(awsLeaks.length, 1);
  assert.strictEqual(awsLeaks[0].ruleId, 'aws-access-key-id');
  console.log('  PASS: GitHub PAT 및 AWS Access Key 누출 정밀 감지');
}

// 3. Allowlist (오탐 방지) 검증: UUID 및 Commit Hash
{
  const safeText = `
  NOTION_DATABASE_ID=3e404d37-c225-8139-8d33-e89fad623b0f
  CommitHash=c66c70f30c66c70f30c66c70f30c66c70f30c66c
  Dummy=mock-key
  `.trim();

  const safeLeaks = scanSecrets(safeText);
  assert.strictEqual(safeLeaks.length, 0, 'UUID와 CommitHash는 시크릿으로 오탐되지 않아야 함');
  console.log('  PASS: Notion Database UUID 및 Git Commit Hash Allowlist 오탐 방지 검증');
}

// 4. 마크다운 파서 연동 검증 (비밀값 주입 시 parseHandoverMarkdown 거부)
{
  const leakedMarkdown = `
# 1. 목표
테스트 인수인계 파일

# 2. 현재 상태
진행 중

# 3. 실행 명령
\`\`\`powershell
$env:NOTION_API_KEY = "secret_0123456789abcdef0123456789abcdef"
node ./bin/session-sync.js --help
\`\`\`

# 4. 통과 검사
T01 통과

# 5. 남은 문제
없음이 아니라 문제 없음

# 6. 다음 행동
\`scripts/collect.js\` 수정

# 7. 건드리지 말 것
\`lib/markdown-parser.js\` 수정 금지
  `.trim();

  const parseRes = parseHandoverMarkdown(leakedMarkdown);
  assert.strictEqual(parseRes.isValid, false, '비밀값 포함 시 파싱 실패해야 함');
  const hasLeakError = parseRes.errors.some((err) => err.includes('[GUARD_ERROR: LEAKED_SECRET]'));
  assert.strictEqual(hasLeakError, true, 'LEAKED_SECRET 가드레일 에러가 발생해야 함');
  console.log('  PASS: 마크다운 파서 연동 시 비밀값 노출 즉시 하드 차단 (T05-C38 준수)');
}

console.log('[TEST] All Gitleaks Secret Scanner Tests Passed Successfully.');
