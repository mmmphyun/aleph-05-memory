/**
 * 7섹션 의미론적 델타 연산기 단위 테스트
 */

const assert = require('node:assert');
const {
  extractSections,
  computeMarkdownDelta,
  formatDeltaSummary,
  reconstructFullMarkdown
} = require('../lib/diff-engine');

console.log('[TEST] Starting Diff Engine Tests...');

const baseMarkdown = `# 1. 목표
세션 동기화 엔진 기본 기능 구현 및 안정화.

# 2. 현재 상태
- 베이스 커밋: 1111111111111111111111111111111111111111
- 상태: 안정화 완료

# 3. 실행 명령
\`\`\`powershell
npm test
\`\`\`

# 4. 통과 검사
- 7개 테스트 스위트 정상 통과

# 5. 남은 문제
- 오프라인 큐 미구현

# 6. 다음 행동
- 대상 파일: \`lib/local-cache.js\`
- 기능 구현 진행

# 7. 건드리지 말 것
- \`lib/markdown-parser.js\` 수정 금지
`;

const targetMarkdown = `# 1. 목표
세션 동기화 엔진 기본 기능 구현 및 안정화.

# 2. 현재 상태
- 베이스 커밋: 2222222222222222222222222222222222222222
- 상태: 신규 기능 추가

# 3. 실행 명령
\`\`\`powershell
npm test
\`\`\`

# 4. 통과 검사
- 10개 테스트 스위트 정상 통과

# 5. 남은 문제
- 모든 문제 해결됨

# 6. 다음 행동
- 대상 파일: \`lib/local-cache.js\`
- 기능 구현 진행

# 7. 건드리지 말 것
- \`lib/markdown-parser.js\` 수정 금지
`;

// 1. 섹션 파싱 테스트
{
  const sections = extractSections(baseMarkdown);
  assert.ok(sections['목표'].includes('세션 동기화 엔진'));
  assert.ok(sections['건드리지 말 것'].includes('수정 금지'));
  console.log('  PASS: H1 기반 7대 섹션 정밀 추출');
}

// 2. 델타 연산 테스트
{
  const delta = computeMarkdownDelta(baseMarkdown, targetMarkdown);
  assert.strictEqual(delta.hasChanges, true);
  assert.deepStrictEqual(delta.changedSections, ['현재 상태', '통과 검사', '남은 문제']);
  assert.deepStrictEqual(delta.unchangedSections, ['목표', '실행 명령', '다음 행동', '건드리지 말 것']);
  console.log('  PASS: 변경된 섹션 및 유지된 섹션 분리 연산');

  // 요약 마크다운 생성 확인
  const summary = formatDeltaSummary(delta, '1111111', '2222222');
  assert.ok(summary.includes('변경된 섹션 (3개)'));
  assert.ok(summary.includes('## 2. 현재 상태 [수정됨]'));
  console.log('  PASS: 터미널 출력용 델타 요약 마크다운 렌더링');

  // 완전체 7섹션 재구성 복원 확인 (A6 가드레일 정합성)
  const fullReconstructed = reconstructFullMarkdown(baseMarkdown, delta);
  assert.ok(fullReconstructed.includes('# 1. 목표'));
  assert.ok(fullReconstructed.includes('# 7. 건드리지 말 것'));
  assert.ok(fullReconstructed.includes('2222222222222222222222222222222222222222'));
  console.log('  PASS: 델타와 베이스라인 결합을 통한 완전체 7섹션 재구성');
}

console.log('[TEST] All Diff Engine Tests Passed Successfully.');
