/**
 * scaffold 모듈 단위 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { generateScaffoldMarkdown, executeScaffold } = require('../lib/scaffold');
const { parseHandoverMarkdown } = require('../lib/markdown-parser');

const testOutDir = path.resolve(__dirname, 'out/test-scaffold');
if (!fs.existsSync(testOutDir)) {
  fs.mkdirSync(testOutDir, { recursive: true });
}

console.log('[TEST] Starting Scaffold Tests...');

// 1. 생성된 마크다운이 7대 가드레일을 100% 통과하는지 검증
{
  const markdown = generateScaffoldMarkdown({ cwd: path.resolve(__dirname, '..') });
  const parseResult = parseHandoverMarkdown(markdown, { workspaceDir: path.resolve(__dirname, '..') });

  assert.strictEqual(parseResult.isValid, true, `Scaffold 마크다운은 가드레일을 통과해야 함: ${JSON.stringify(parseResult.errors)}`);
  assert.ok(parseResult.sections.goal, '목표 섹션 존재');
  assert.ok(parseResult.sections.status, '현재 상태 섹션 존재');
  assert.ok(parseResult.sections.command, '실행 명령 섹션 존재');
  assert.ok(parseResult.sections.passed, '통과 검사 섹션 존재');
  assert.ok(parseResult.sections.issues, '남은 문제 섹션 존재');
  assert.ok(parseResult.sections.next, '다음 행동 섹션 존재');
  assert.ok(parseResult.sections.prohibited, '건드리지 말 것 섹션 존재');
  console.log('  PASS: 생성된 초안의 7대 가드레일 무결성 통과 검증');
}

// 2. 파일 쓰기 및 대상 디렉토리 자동 생성 검증
{
  const targetFile = path.join(testOutDir, 'HANDOVER_GEN.md');
  if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);

  const res = executeScaffold({
    cwd: path.resolve(__dirname, '..'),
    out: targetFile,
    force: false,
    throwOnError: true
  });

  assert.strictEqual(res.success, true);
  assert.ok(fs.existsSync(targetFile), '타겟 파일이 생성되어야 함');
  const written = fs.readFileSync(targetFile, 'utf8');
  assert.ok(written.includes('# 1. 목표'), '마크다운 내용이 정상 기록되어야 함');
  console.log('  PASS: 파일 직접 쓰기(--out) 및 영속화 검증');
}

// 3. 파일 존재 시 --force 미지정 시 차단 및 --force 지정 시 덮어쓰기 검증
{
  const targetFile = path.join(testOutDir, 'HANDOVER_PROTECT.md');
  fs.writeFileSync(targetFile, '# Existing Content', 'utf8');

  // 차단 검증
  assert.throws(
    () => {
      executeScaffold({
        cwd: path.resolve(__dirname, '..'),
        out: targetFile,
        force: false,
        throwOnError: true
      });
    },
    /already exists/,
    '기존 파일 존재 시 --force 없으면 에러가 발생해야 함'
  );

  // 덮어쓰기 검증
  const res = executeScaffold({
    cwd: path.resolve(__dirname, '..'),
    out: targetFile,
    force: true,
    throwOnError: true
  });
  assert.strictEqual(res.success, true);
  const updated = fs.readFileSync(targetFile, 'utf8');
  assert.ok(updated.includes('# 1. 목표'), '--force 지정 시 정상 덮어써져야 함');
  console.log('  PASS: 기존 파일 존재 시 보호 및 --force 덮어쓰기 정책 검증');
}

// 4. stdout 모드 검증
{
  const res = executeScaffold({
    cwd: path.resolve(__dirname, '..'),
    stdout: true
  });
  assert.strictEqual(res.mode, 'stdout');
  assert.ok(res.content.includes('# 1. 목표'));
  console.log('  PASS: stdout 출력 모드 검증');
}

console.log('[TEST] All Scaffold Tests Passed Successfully.');
