/**
 * 프로젝트 메타데이터 자동 추출 및 로컬 캐싱 단위 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  detectTechStack,
  extractReadmeSummary,
  collectProjectMetadata,
  loadProjectCache,
  saveProjectCache
} = require('../lib/project-metadata');

console.log('[TEST] Starting Project Metadata Tests...');

const tempDir = path.resolve(__dirname, 'out/test-meta');
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
fs.mkdirSync(tempDir, { recursive: true });

// 1. 기술 스택 감지 테스트 (Node.js, Docker 등)
{
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM node', 'utf8');
  const stacks = detectTechStack(tempDir);
  assert.ok(stacks.includes('Node.js'), 'Node.js 스택 감지되어야 함');
  assert.ok(stacks.includes('Docker'), 'Docker 스택 감지되어야 함');
  console.log('  PASS: 기술 스택 시그니처 파일 기반 자동 감지');
}

// 2. README 요약 슬라이싱 (최대 200자 제한 및 첫 문단 추출)
{
  const readmeContent = `# Project Aleph\n\nThis is a high performance zero-dependency session sync tool designed for AI agent handovers.\n\n## Sub Title\nExtra details.`;
  fs.writeFileSync(path.join(tempDir, 'README.md'), readmeContent, 'utf8');
  const summary = extractReadmeSummary(tempDir);
  assert.strictEqual(summary, 'This is a high performance zero-dependency session sync tool designed for AI agent handovers.');
  console.log('  PASS: README 최상단 30줄 내 첫 문단 정밀 추출');
}

// 3. 로컬 캐시(.session-sync.json) 저장 및 로드
{
  const testData = {
    projectName: 'test-proj',
    projectsDatabaseId: 'db-123',
    projectPageId: 'page-456'
  };
  saveProjectCache(tempDir, testData);
  const loaded = loadProjectCache(tempDir);
  assert.strictEqual(loaded.projectName, 'test-proj');
  assert.strictEqual(loaded.projectsDatabaseId, 'db-123');
  assert.strictEqual(loaded.projectPageId, 'page-456');
  assert.ok(loaded.updatedAt, 'updatedAt 타임스탬프 존재해야 함');
  console.log('  PASS: .session-sync.json 로컬 메타데이터 캐시 무결성');
}

// 정리
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('[TEST] All Project Metadata Tests Passed Successfully.');
