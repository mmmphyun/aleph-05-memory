/**
 * 마크다운 파서 및 7칸 가드레일 단위 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHandoverMarkdown } = require('../lib/markdown-parser');

console.log('[TEST] Starting Markdown Parser & Guardrail Tests...');

const validFixture = fs.readFileSync(path.join(__dirname, 'fixtures/valid-handover.md'), 'utf8');
const missingFixture = fs.readFileSync(path.join(__dirname, 'fixtures/missing-section.md'), 'utf8');
const bypassFixture = fs.readFileSync(path.join(__dirname, 'fixtures/bypass-handover.md'), 'utf8');

// 1. 정상 인수인계 파싱: 7개 필수 섹션 정상 추출 및 isValid === true
{
  const result = parseHandoverMarkdown(validFixture);
  assert.strictEqual(result.isValid, true, '정상 인수인계는 유효해야 함');
  assert.strictEqual(result.errors.length, 0, '에러가 없어야 함');
  assert.ok(result.sections.goal, 'goal 섹션 존재해야 함');
  assert.ok(result.sections.status, 'status 섹션 존재해야 함');
  assert.ok(result.sections.command, 'command 섹션 존재해야 함');
  assert.ok(result.sections.passed, 'passed 섹션 존재해야 함');
  assert.ok(result.sections.issues, 'issues 섹션 존재해야 함');
  assert.ok(result.sections.next, 'next 섹션 존재해야 함');
  assert.ok(result.sections.prohibited, 'prohibited 섹션 존재해야 함');
  assert.strictEqual(result.sections.command.parsedCommands.length, 2, '파싱된 명령어 2개 확인');
  console.log('  PASS: 정상 7칸 인수인계 파일 완전 파싱 검증');
}

// 2. 필수 섹션 누락 탐지 (T03 검증 기반)
{
  const result = parseHandoverMarkdown(missingFixture);
  assert.strictEqual(result.isValid, false, '섹션 누락 시 isValid === false 여야 함');
  const hasMissingProhibited = result.errors.some((err) => err.includes("Missing required section: '건드리지 말 것'"));
  assert.strictEqual(hasMissingProhibited, true, '건드리지 말 것 누락 에러 감지되어야 함');
  console.log('  PASS: 필수 섹션 누락 정밀 감지');
}

// 3. 에이전트 불성실 기재/회피 꼼수 차단 (Guard 1 검증)
{
  const result = parseHandoverMarkdown(bypassFixture);
  assert.strictEqual(result.isValid, false, '회피성 기재 시 isValid === false 여야 함');
  assert.ok(result.errors.length >= 3, '최소 3개 이상의 섹션에서 가드레일 에러 발생해야 함');
  const hasGuardError = result.errors.some((err) => err.includes('[GUARD_ERROR]'));
  assert.strictEqual(hasGuardError, true, 'GUARD_ERROR 태그가 에러에 포함되어야 함');
  console.log('  PASS: 불성실 플레이스홀더(TODO, N/A, 없음 등) 회피 차단');
}

console.log('[TEST] All Markdown Parser & Guardrail Tests Passed Successfully.');
