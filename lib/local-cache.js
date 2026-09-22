/**
 * 오프라인 로컬 캐시 및 폴백 저장소
 * Notion 전송 실패 시 .sync_cache/ 디렉토리에 페이로드를 영구 보존
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.sync_cache');

/**
 * 캐시 디렉토리 확보
 * @param {string} cacheDir 
 */
function ensureCacheDir(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

/**
 * 세션 데이터를 로컬 캐시 JSON으로 영구 저장
 * @param {object} sessionData 
 * @param {string} cacheDir 
 * @returns {string} 생성된 캐시 파일 경로
 */
function saveToCache(sessionData, cacheDir = DEFAULT_CACHE_DIR) {
  ensureCacheDir(cacheDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const phase = sessionData.phase || 'SESSION';
  const commit = (sessionData.commitHash || 'unknown').slice(0, 7);
  const filename = `session-${timestamp}-${phase}-${commit}.json`;
  const filePath = path.join(cacheDir, filename);

  const payload = {
    cachedAt: new Date().toISOString(),
    project: sessionData.project || 'unknown',
    phase: sessionData.phase || 'WIP',
    commitHash: sessionData.commitHash || null,
    summary: sessionData.summary || '',
    tags: sessionData.tags || [],
    passCount: sessionData.passCount || 0,
    failCount: sessionData.failCount || 0,
    blocks: sessionData.blocks || [],
    rawMarkdown: sessionData.rawMarkdown || ''
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

/**
 * 캐시된 세션 목록 조회 (최신순 정렬)
 * @param {string} cacheDir 
 * @returns {object[]}
 */
function listCachedSessions(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) return [];

  const files = fs.readdirSync(cacheDir)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map((file) => {
    const fullPath = path.join(cacheDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      return { file, fullPath, ...data };
    } catch {
      return { file, fullPath, corrupted: true };
    }
  });
}

/**
 * 가장 최신 캐시된 세션 데이터 조회
 * @param {string} cacheDir 
 * @returns {object|null}
 */
function getLatestCachedSession(cacheDir = DEFAULT_CACHE_DIR) {
  const list = listCachedSessions(cacheDir);
  return list.length > 0 ? list[0] : null;
}

module.exports = {
  DEFAULT_CACHE_DIR,
  ensureCacheDir,
  saveToCache,
  listCachedSessions,
  getLatestCachedSession
};
