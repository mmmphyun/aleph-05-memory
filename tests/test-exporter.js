/**
 * 로컬 마크다운 아카이버 단위 테스트
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  ensureGitignoreEntry,
  exportSessionMarkdown,
  listExportedArchives
} = require('../lib/exporter');

console.log('[TEST] Starting Exporter Tests...');

const tempDir = path.resolve(__dirname, 'out/test-export');
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
fs.mkdirSync(tempDir, { recursive: true });

// 1. .gitignore 자동 등록 검증
{
  ensureGitignoreEntry(tempDir, '.session-memory/');
  const gitignorePath = path.join(tempDir, '.gitignore');
  assert.ok(fs.existsSync(gitignorePath), '.gitignore 파일 생성되어야 함');
  const content = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(content.includes('.session-memory/'));

  // 중복 등록 방지 검증
  ensureGitignoreEntry(tempDir, '.session-memory/');
  const content2 = fs.readFileSync(gitignorePath, 'utf8');
  const count = (content2.match(/\.session-memory\//g) || []).length;
  assert.strictEqual(count, 1, '중복 등록되지 않아야 함');
  console.log('  PASS: .gitignore 자동 등록 및 멱등성 보장');
}

// 2. 마크다운 아카이브 내보내기 검증
{
  const archiveDir = path.join(tempDir, 'archives');
  const sessionData = {
    project: 'aleph-export-test',
    phase: 'A_END',
    commitHash: '3333333333333333333333333333333333333333',
    passCount: 5,
    failCount: 0,
    tags: ['test', 'archive'],
    rawMarkdown: '# 1. 목표\nExport test'
  };

  const exportedFile = exportSessionMarkdown(sessionData, archiveDir);
  assert.ok(fs.existsSync(exportedFile), '아카이브 파일이 생성되어야 함');
  const content = fs.readFileSync(exportedFile, 'utf8');
  assert.ok(content.includes('archived_at:'), '프론트매터 메타데이터 포함되어야 함');
  assert.ok(content.includes('# 1. 목표\nExport test'), '본문 마크다운 포함되어야 함');
  console.log('  PASS: 세션 마크다운 아카이브 생성 및 프론트매터 주입');

  // 목록 조회 검증
  const archives = listExportedArchives(archiveDir);
  assert.strictEqual(archives.length, 1);
  assert.ok(archives[0].file.endsWith('.md'));
  console.log('  PASS: 내보낸 마크다운 아카이브 목록 조회');
}

// 정리
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('[TEST] All Exporter Tests Passed Successfully.');
