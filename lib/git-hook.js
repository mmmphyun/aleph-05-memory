/**
 * Git pre-push 훅 설치 및 실행 모듈
 * Fail-Open 정책 적용: 마크다운 가드레일 실패 시 차단(exit 1), 네트워크/API 장애 시 로컬 Pending 큐 저장 후 통과(exit 0).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { parseHandoverMarkdown } = require('./markdown-parser');
const { markdownToNotionBlocks } = require('./block-transformer');
const { savePendingSession } = require('./local-cache');
const { getGitMetadata } = require('./sync-engine');

const HOOK_TEMPLATE = `#!/bin/sh
# session-sync 자동 생성 pre-push 훅
session-sync hook exec "$@"
`;

/**
 * Git hooks 디렉토리 동적 추출
 * 1. git rev-parse --git-path hooks 호출
 * 2. 실패 시 .git 파일/디렉토리 검사 (Worktree gitdir 파싱)
 * 3. Git 부재 시 .session-memory/hooks 로컬 경로 fallback
 */
function resolveGitHooksDir(rootDir) {
  const normalizedRoot = path.resolve(rootDir);

  // 1. git CLI로 현재 디렉토리가 저장소/워크트리 루트인지 확인 후 hooks 경로 추출
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      cwd: normalizedRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (toplevel && path.resolve(toplevel).toLowerCase() === normalizedRoot.toLowerCase()) {
      const stdout = execSync('git rev-parse --git-path hooks', {
        cwd: normalizedRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (stdout) {
        return path.resolve(normalizedRoot, stdout);
      }
    }
  } catch (_err) {
    // git CLI 부재 또는 git 명령 실패
  }

  // 2. 파일 시스템 기반 .git 검사 (Worktree gitdir 파싱 포함)
  const gitPath = path.join(normalizedRoot, '.git');
  if (fs.existsSync(gitPath)) {
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return path.join(gitPath, 'hooks');
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDir = path.resolve(normalizedRoot, match[1].trim());
          const commonDirFile = path.join(gitDir, 'commondir');
          if (fs.existsSync(commonDirFile)) {
            const commonRel = fs.readFileSync(commonDirFile, 'utf8').trim();
            return path.resolve(gitDir, commonRel, 'hooks');
          }
          return path.join(gitDir, 'hooks');
        }
      }
    } catch (_statErr) {
      // ignore
    }
  }

  // 3. Git 부재 환경: 로컬 .session-memory/hooks 반환
  return path.join(normalizedRoot, '.session-memory', 'hooks');
}

/**
 * Git pre-push 훅 설치
 */
function installHook(customRootDir) {
  const rootDir = customRootDir || process.cwd();
  const hooksDir = resolveGitHooksDir(rootDir);
  const isLocalBackup = hooksDir.includes(path.join('.session-memory', 'hooks'));

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, 'pre-push');
  if (fs.existsSync(hookPath)) {
    const backupPath = path.join(hooksDir, 'pre-push.bak');
    fs.copyFileSync(hookPath, backupPath);
    console.log(`[HOOK_BACKUP] Existing pre-push hook backed up to ${backupPath}`);
  }

  fs.writeFileSync(hookPath, HOOK_TEMPLATE, { encoding: 'utf8', mode: 0o755 });
  if (isLocalBackup) {
    console.warn(`[HOOK_WARN] Git repository not detected. Pre-push hook backed up locally at ${hookPath}`);
  } else {
    console.log(`[HOOK_INSTALLED] pre-push hook installed successfully at ${hookPath}`);
  }
  return hookPath;
}

/**
 * pre-push 훅 실행 핸들러
 */
async function executeHook(options = {}, syncEngine = null) {
  const rootDir = options.rootDir || process.cwd();
  const handoverPath = path.join(rootDir, options.file || 'HANDOVER.md');

  if (!fs.existsSync(handoverPath)) {
    console.warn(`[HOOK_SKIP] Handover file not found at ${handoverPath}. Skipping session sync.`);
    return { success: true, skipped: true };
  }

  const markdownContent = fs.readFileSync(handoverPath, 'utf8');

  // 1. 마크다운 가드레일 엄격 검증 (실패 시 차단)
  let parsed;
  try {
    parsed = parseHandoverMarkdown(markdownContent);
    console.log(`[HOOK_VERIFY] HANDOVER.md passed all 7 guardrail checks.`);
  } catch (err) {
    console.error(`[HOOK_FAIL] HANDOVER.md failed guardrail validation: ${err.message}`);
    process.exit(1);
  }

  // 2. 푸시 시도 (Fail-Open 적용)
  const engine = syncEngine || require('./sync-engine');
  try {
    const result = await engine.executePush({
      file: handoverPath,
      phase: options.phase || 'A_END',
      pass: options.pass || 0,
      fail: options.fail || 0,
      tags: options.tags || 'git-hook,pre-push'
    });
    console.log(`[HOOK_SUCCESS] Session synced to Notion DB successfully.`);
    return { success: true, result };
  } catch (pushErr) {
    console.warn(`[HOOK_WARN] Network or Notion API failure: ${pushErr.message}`);
    console.warn(`[HOOK_WARN] Fail-Open activated: Session saved to local pending queue.`);

    const gitMeta = getGitMetadata();
    const blocks = markdownToNotionBlocks(markdownContent);
    const sessionData = {
      project: gitMeta.projectName,
      phase: options.phase || 'A_END',
      commitHash: gitMeta.commitHash,
      summary: parsed.summary || (parsed.sections && parsed.sections['목표'] ? parsed.sections['목표'].slice(0, 100) : ''),
      tags: ['git-hook', 'pre-push', 'pending'],
      passCount: Number(options.pass) || 0,
      failCount: Number(options.fail) || 0,
      blocks,
      rawMarkdown: markdownContent
    };

    const savedFile = savePendingSession(sessionData);
    console.log(`[HOOK_PENDING] Enqueued offline snapshot at ${savedFile}`);
    return { success: true, pending: true, path: savedFile };
  }
}

module.exports = {
  HOOK_TEMPLATE,
  resolveGitHooksDir,
  installHook,
  executeHook
};
