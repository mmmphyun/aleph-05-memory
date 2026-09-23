/**
 * 오프라인 로컬 캐시 및 폴백/재시도 큐 모듈
 * Notion 전송 실패 시 .sync_cache/pending/ 에 저장하여 추후 자동 재전송(Fail-Open) 지원
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.sync_cache');
const PENDING_SUBDIR = 'pending';
const COMPLETED_SUBDIR = 'completed';

/**
 * 캐시 디렉토리 및 서브 디렉토리 확보
 */
function ensureCacheDir(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const pendingDir = path.join(cacheDir, PENDING_SUBDIR);
  if (!fs.existsSync(pendingDir)) {
    fs.mkdirSync(pendingDir, { recursive: true });
  }
  const completedDir = path.join(cacheDir, COMPLETED_SUBDIR);
  if (!fs.existsSync(completedDir)) {
    fs.mkdirSync(completedDir, { recursive: true });
  }
}

/**
 * 파일명 생성 헬퍼
 */
function generateFilename(sessionData) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const phase = sessionData.phase || 'SESSION';
  const commit = (sessionData.commitHash || 'unknown').slice(0, 7);
  return `session-${timestamp}-${phase}-${commit}.json`;
}

/**
 * 표준 세션 페이로드 직렬화
 */
function serializePayload(sessionData) {
  return {
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
}

/**
 * 세션 데이터를 로컬 캐시 JSON으로 영구 저장 (기존 기본 캐시)
 */
function saveToCache(sessionData, cacheDir = DEFAULT_CACHE_DIR) {
  ensureCacheDir(cacheDir);
  const filename = generateFilename(sessionData);
  const filePath = path.join(cacheDir, filename);
  const payload = serializePayload(sessionData);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

/**
 * 오프라인/장애 발생 시 Pending 재시도 큐에 세션 저장 (Fail-Open)
 */
function savePendingSession(sessionData, cacheDir = DEFAULT_CACHE_DIR) {
  ensureCacheDir(cacheDir);
  const filename = generateFilename(sessionData);
  const filePath = path.join(cacheDir, PENDING_SUBDIR, filename);
  const payload = {
    ...serializePayload(sessionData),
    status: 'PENDING_RETRY',
    enqueuedAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

/**
 * Pending 큐 목록 조회 (FIFO 순서 - 오래된 항목부터)
 */
function getPendingQueue(cacheDir = DEFAULT_CACHE_DIR) {
  const pendingDir = path.join(cacheDir, PENDING_SUBDIR);
  if (!fs.existsSync(pendingDir)) return [];

  const files = fs.readdirSync(pendingDir)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
    .sort(); // 타임스탬프 오름차순 (FIFO)

  return files.map((file) => {
    const fullPath = path.join(pendingDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      return { file, fullPath, ...data };
    } catch {
      return { file, fullPath, corrupted: true };
    }
  });
}

/**
 * Pending 세션 전송 완료 처리 (completed 디렉토리로 이동)
 */
function markPendingCompleted(pendingFilePath, cacheDir = DEFAULT_CACHE_DIR) {
  ensureCacheDir(cacheDir);
  if (!fs.existsSync(pendingFilePath)) return;

  const fileName = path.basename(pendingFilePath);
  const destPath = path.join(cacheDir, COMPLETED_SUBDIR, fileName);

  try {
    fs.renameSync(pendingFilePath, destPath);
  } catch {
    fs.copyFileSync(pendingFilePath, destPath);
    fs.unlinkSync(pendingFilePath);
  }
}

/**
 * 캐시된 세션 목록 조회 (최신순 정렬)
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
 */
function getLatestCachedSession(cacheDir = DEFAULT_CACHE_DIR) {
  const list = listCachedSessions(cacheDir);
  return list.length > 0 ? list[0] : null;
}

module.exports = {
  DEFAULT_CACHE_DIR,
  PENDING_SUBDIR,
  COMPLETED_SUBDIR,
  ensureCacheDir,
  saveToCache,
  savePendingSession,
  getPendingQueue,
  markPendingCompleted,
  listCachedSessions,
  getLatestCachedSession
};
