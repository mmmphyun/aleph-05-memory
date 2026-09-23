/**
 * Git pre-push 훅 설치 및 실행 모듈
 * Fail-Open 정책 적용: 마크다운 가드레일 실패 시 차단(exit 1), 네트워크/API 장애 시 로컬 Pending 큐 저장 후 통과(exit 0).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseHandoverMarkdown } = require('./markdown-parser');
const { markdownToNotionBlocks } = require('./block-transformer');
const { savePendingSession } = require('./local-cache');
const { getGitMetadata } = require('./sync-engine');

const HOOK_TEMPLATE = `#!/bin/sh
# session-sync 자동 생성 pre-push 훅
node ./bin/session-sync.js hook exec "$@"
`;

/**
 * Git pre-push 훅 설치
 */
function installHook(customRootDir) {
  const rootDir = customRootDir || process.cwd();
  const gitDir = path.join(rootDir, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`[HOOK_INSTALL_ERROR] '.git' directory not found in ${rootDir}`);
  }

  const hooksDir = path.join(gitDir, 'hooks');
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
  console.log(`[HOOK_INSTALLED] pre-push hook installed successfully at ${hookPath}`);
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
  installHook,
  executeHook
};
