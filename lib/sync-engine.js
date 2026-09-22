/**
 * 세션 메모리 동기화 코어 엔진 (init, push, fetch 파이프라인)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { parseHandoverMarkdown } = require('./markdown-parser');
const { markdownToNotionBlocks, notionBlocksToMarkdown } = require('./block-transformer');
const { NotionClient } = require('./notion-client');
const { saveToCache, getLatestCachedSession, listCachedSessions } = require('./local-cache');

/**
 * Git Ground-Truth 메타데이터 추출
 */
function getGitMetadata() {
  try {
    const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const projectName = path.basename(repoRoot);
    const isDirty = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().length > 0;
    return { commitHash, projectName, isDirty };
  } catch {
    return { commitHash: '0000000000000000000000000000000000000000', projectName: 'unknown-project', isDirty: false };
  }
}

/**
 * Database 스키마 정의 (Leaf 계층)
 */
function getDatabaseSchema(title = 'Agent Session Memory DB') {
  return {
    title: [{ type: 'text', text: { content: title } }],
    properties: {
      Title: { title: {} },
      Project: { select: {} },
      Phase: {
        select: {
          options: [
            { name: 'A_START', color: 'blue' },
            { name: 'A_END', color: 'purple' },
            { name: 'B_START', color: 'yellow' },
            { name: 'B_END', color: 'green' },
            { name: 'WIP', color: 'gray' }
          ]
        }
      },
      CommitHash: { rich_text: {} },
      Summary: { rich_text: {} },
      Tags: { multi_select: {} },
      PassCount: { number: { format: 'number' } },
      FailCount: { number: { format: 'number' } },
      Status: {
        status: {
          options: [
            { name: 'In Progress', color: 'gray' },
            { name: 'Handed Over', color: 'blue' },
            { name: 'Completed', color: 'green' }
          ]
        }
      },
      UpdatedAt: { date: {} }
    }
  };
}

/**
 * Leaf 프로퍼티 페이로드 생성
 */
function buildPageProperties(sessionData) {
  const tagsList = Array.isArray(sessionData.tags)
    ? sessionData.tags
    : (sessionData.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  return {
    Title: {
      title: [{ type: 'text', text: { content: sessionData.title || 'Session Handover' } }]
    },
    Project: {
      select: { name: sessionData.project || 'unknown-project' }
    },
    Phase: {
      select: { name: sessionData.phase || 'WIP' }
    },
    CommitHash: {
      rich_text: [{ type: 'text', text: { content: sessionData.commitHash || '' } }]
    },
    Summary: {
      rich_text: [{ type: 'text', text: { content: sessionData.summary || '' } }]
    },
    Tags: {
      multi_select: tagsList.map((tag) => ({ name: tag }))
    },
    PassCount: {
      number: Number(sessionData.passCount) || 0
    },
    FailCount: {
      number: Number(sessionData.failCount) || 0
    },
    Status: {
      status: { name: sessionData.phase && sessionData.phase.includes('END') ? 'Handed Over' : 'In Progress' }
    },
    UpdatedAt: {
      date: { start: new Date().toISOString() }
    }
  };
}

/**
 * push 명령어 실행
 */
async function executePush(options = {}) {
  const filePath = path.resolve(process.cwd(), options.file || 'HANDOVER.md');

  if (!fs.existsSync(filePath)) {
    console.error(`[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  const rawMarkdown = fs.readFileSync(filePath, 'utf8');

  // 1. 7칸 인수인계 가드레일 유효성 검증
  const parseResult = parseHandoverMarkdown(rawMarkdown);
  if (!parseResult.isValid) {
    for (const err of parseResult.errors) {
      console.error(err);
    }
    process.exit(1);
  }

  console.log('[VALIDATION_SUCCESS] 7 required sections verified.');

  // 2. Git 메타데이터 추출
  const gitMeta = getGitMetadata();
  const commitHash = options.commit || gitMeta.commitHash;
  const project = options.project || gitMeta.projectName;

  // 3. 블록 변환 (2,000자 청크 분할)
  const blocks = markdownToNotionBlocks(rawMarkdown);

  // 4. Dry-run 모드 처리
  if (options['dry-run']) {
    console.log(`[DRY_RUN] Successfully parsed and generated ${blocks.length} Notion blocks.`);
    if (options['dump-blocks']) {
      console.log(JSON.stringify(blocks, null, 2));
    }
    if (options.out) {
      fs.writeFileSync(path.resolve(process.cwd(), options.out), JSON.stringify(blocks, null, 2), 'utf8');
      console.log(`[DRY_RUN] Blocks dumped to ${options.out}`);
    }
    return { success: true, mode: 'dry-run', blocks };
  }

  // 5. 세션 데이터 집계
  const sessionData = {
    title: options.title || parseResult.sections.goal.content.split('\n')[0].slice(0, 80) || 'Session Handover',
    project,
    phase: options.phase || 'WIP',
    commitHash,
    summary: options.summary || parseResult.sections.goal.content.slice(0, 100),
    tags: options.tags || ['handover'],
    passCount: options.pass !== undefined ? options.pass : 0,
    failCount: options.fail !== undefined ? options.fail : 0,
    blocks,
    rawMarkdown
  };

  // 6. Notion 전송 또는 캐시 폴백
  const apiKey = options['api-key'] || process.env.NOTION_API_KEY;
  const dbId = options.db || process.env.NOTION_DATABASE_ID;

  if (!apiKey) {
    console.error('[AUTH_ERROR] NOTION_API_KEY is not set in environment');
    process.exit(1);
  }

  const client = new NotionClient({
    apiKey,
    baseUrl: options['mock-port'] ? `http://127.0.0.1:${options['mock-port']}` : undefined
  });

  try {
    const pageProperties = buildPageProperties(sessionData);
    const res = await client.createPage(dbId || 'default-db', pageProperties, blocks);
    console.log(`[SYNC_SUCCESS] Page created in Notion. ID: ${res.data.id}`);
    return { success: true, pageId: res.data.id };
  } catch (err) {
    console.error(`[SYNC_FAIL] ${err.message}`);
    if (options['fallback-cache']) {
      const cachedFile = saveToCache(sessionData);
      console.log(`[FALLBACK] Cached to .sync_cache/ (Saved: ${cachedFile})`);
      return { success: true, mode: 'fallback-cache', cachedFile };
    }
    process.exit(1);
  }
}

/**
 * fetch 명령어 실행
 */
async function executeFetch(options = {}) {
  const apiKey = options['api-key'] || process.env.NOTION_API_KEY || 'dummy-key';
  const dbId = options.db || process.env.NOTION_DATABASE_ID || 'default-db';

  const client = new NotionClient({
    apiKey,
    baseUrl: options['mock-port'] ? `http://127.0.0.1:${options['mock-port']}` : undefined
  });

  // 1. 목차 조회 (--list: Leaf 계층 경량 인출)
  if (options.list) {
    try {
      const queryRes = await client.queryDatabase(dbId, {});
      const results = queryRes.data.results || [];
      console.log('--------------------------------------------------------------------------------');
      console.log('| Project         | Phase   | Commit    | Title                                  |');
      console.log('--------------------------------------------------------------------------------');
      for (const item of results) {
        const props = item.properties || {};
        const proj = (props.Project && props.Project.select && props.Project.select.name) || 'unknown';
        const phase = (props.Phase && props.Phase.select && props.Phase.select.name) || 'WIP';
        const commit = (props.CommitHash && props.CommitHash.rich_text && props.CommitHash.rich_text[0] && props.CommitHash.rich_text[0].plain_text) || '--------';
        const title = (props.Title && props.Title.title && props.Title.title[0] && props.Title.title[0].plain_text) || 'No Title';
        console.log(`| ${proj.padEnd(15)} | ${phase.padEnd(7)} | ${commit.slice(0, 9).padEnd(9)} | ${title.slice(0, 38).padEnd(38)} |`);
      }
      console.log('--------------------------------------------------------------------------------');
      return { success: true, count: results.length };
    } catch (err) {
      console.error(`[FETCH_ERROR] ${err.message}`);
      // 로컬 캐시 목차 폴백
      const cached = listCachedSessions();
      console.log(`[FALLBACK] Local cache entries: ${cached.length}`);
      return { success: true, count: cached.length, mode: 'cache-fallback' };
    }
  }

  // 2. 최신 또는 특정 세션 본문 복원 (--latest / --tag)
  let restoredMarkdown = '';
  try {
    const queryRes = await client.queryDatabase(dbId, { page_size: 1 });
    const targetPage = queryRes.data.results && queryRes.data.results[0];

    if (targetPage) {
      const childrenRes = await client.getBlockChildren(targetPage.id);
      restoredMarkdown = notionBlocksToMarkdown(childrenRes.data.results || []);
    }
  } catch (err) {
    console.warn(`[NOTION_FETCH_WARN] Failed to fetch from Notion API (${err.message}). Trying local cache...`);
    const latestCache = getLatestCachedSession();
    if (latestCache) {
      restoredMarkdown = latestCache.rawMarkdown;
      console.log(`[CACHE_RESTORED] Restored from local cache: ${latestCache.file}`);
    } else {
      console.error('[ERROR] No remote or local session found to restore.');
      process.exit(1);
    }
  }

  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, restoredMarkdown, 'utf8');
    console.log(`[FETCH_SUCCESS] Handover markdown restored to: ${options.out}`);
  } else {
    console.log(restoredMarkdown);
  }

  return { success: true, markdown: restoredMarkdown };
}

module.exports = {
  getGitMetadata,
  getDatabaseSchema,
  buildPageProperties,
  executePush,
  executeFetch
};
