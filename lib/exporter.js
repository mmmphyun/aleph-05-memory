/**
 * 로컬 마크다운 히스토리 아카이브 내보내기 모듈
 * 세션 데이터를 타임스탬프 기반 마크다운으로 영구 보관하고, Git 오염 방지를 위해 .gitignore에 자동 등록합니다.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ARCHIVE_DIR = path.resolve(process.cwd(), '.session-memory', 'archives');

/**
 * .gitignore 파일에 지정된 경로 추가 (중복 방지)
 */
function ensureGitignoreEntry(rootDir, entry = '.session-memory/') {
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
    return;
  }

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes(entry.trim()) && !lines.includes(entry.replace(/\/$/, ''))) {
    const trailingNewline = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${trailingNewline}${entry}\n`, 'utf8');
  }
}

/**
 * 타임스탬프 포맷 생성: YYYYMMDD_HHmmss
 */
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

/**
 * 세션 데이터를 로컬 마크다운 아카이브로 내보내기
 */
function exportSessionMarkdown(sessionData, customOutputDir) {
  const rootDir = process.cwd();
  const outputDir = customOutputDir ? path.resolve(customOutputDir) : DEFAULT_ARCHIVE_DIR;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 자동 .gitignore 등록
  ensureGitignoreEntry(rootDir, '.session-memory/');

  const ts = formatTimestamp();
  const commit = (sessionData.commitHash || 'unknown').slice(0, 7);
  const phase = sessionData.phase || 'SESSION';
  const filename = `${ts}_${commit}_${phase}.md`;
  const filePath = path.join(outputDir, filename);

  const frontmatter = [
    '---',
    `archived_at: ${new Date().toISOString()}`,
    `project: ${sessionData.project || 'unknown'}`,
    `phase: ${phase}`,
    `commit_hash: ${sessionData.commitHash || ''}`,
    `pass_count: ${sessionData.passCount || 0}`,
    `fail_count: ${sessionData.failCount || 0}`,
    `tags: ${(sessionData.tags || []).join(', ')}`,
    '---',
    '',
    ''
  ].join('\n');

  const fullContent = frontmatter + (sessionData.rawMarkdown || '');
  fs.writeFileSync(filePath, fullContent, 'utf8');

  console.log(`[ARCHIVE_EXPORTED] Session archived at ${filePath}`);
  return filePath;
}

/**
 * 보관된 아카이브 목록 조회 (최신순)
 */
function listExportedArchives(customOutputDir) {
  const outputDir = customOutputDir ? path.resolve(customOutputDir) : DEFAULT_ARCHIVE_DIR;
  if (!fs.existsSync(outputDir)) return [];

  const files = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();

  return files.map((file) => {
    const fullPath = path.join(outputDir, file);
    return {
      file,
      fullPath,
      sizeBytes: fs.statSync(fullPath).size
    };
  });
}

module.exports = {
  DEFAULT_ARCHIVE_DIR,
  ensureGitignoreEntry,
  formatTimestamp,
  exportSessionMarkdown,
  listExportedArchives
};
