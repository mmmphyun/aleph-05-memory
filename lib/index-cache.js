/**
 * Inode mtime 기반 로컬 증분 색인(Incremental Index) 영속화 모듈
 * 
 * 과거 세션 아카이브(.session-memory/archives/*.md) 및 작업 트리 HANDOVER.md의
 * 파일 수정 시간(mtimeMs)을 추적하여 변경된 파일(O(Δ))만 차분 파싱/인덱싱하고,
 * .session-memory/index.json 및 .session-memory/session-index.db(SQLite)에 캐시를 영속화합니다.
 * 
 * 동시 프로세스 접근 시 Check-then-Act 레이스 컨디션을 방지하기 위한
 * 파일 락(Lock) 메커니즘과 Stale Lock 자동 회수 기능을 탑재합니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_ARCHIVE_DIR,
  DEFAULT_HANDOVER_PATH,
  chunkMarkdownBySections,
  tokenize
} = require('./search-engine');
const { SqliteStorage, DEFAULT_DB_PATH } = require('./sqlite-storage');

const DEFAULT_INDEX_PATH = path.resolve(process.cwd(), '.session-memory', 'index.json');
const DEFAULT_LOCK_PATH = path.resolve(process.cwd(), '.session-memory', 'index.lock');

// ============================================================================
// 1. Process Concurrency File Lock (동시성 파일 락 메커니즘)
// ============================================================================

/**
 * 지정된 시간 동안 CPU 양보를 위한 동기식 Sleep (Atomics 기반)
 * 
 * @param {number} ms - 대기 밀리초
 */
function sleepSync(ms) {
  try {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  } catch (_) {
    // SharedArrayBuffer 비활성화 환경을 위한 폴백
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Busy wait fallback
    }
  }
}

/**
 * 원자적 디렉토리 생성(fs.mkdir) 기반 파일 락 획득 (동기)
 * 
 * @param {string} [lockPath=DEFAULT_LOCK_PATH]
 * @param {number} [timeoutMs=5000] - 최대 대기 시간
 * @param {number} [staleMs=10000] - 크래시된 락 간주 시간
 * @returns {boolean} 락 획득 성공 여부
 */
function acquireLockSync(lockPath = DEFAULT_LOCK_PATH, timeoutMs = 5000, staleMs = 10000) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startTime = Date.now();
  let delay = 20;

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.mkdirSync(lockPath);
      // 락 획득 성공
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // 이미 락이 존재하는 경우 Stale 여부 검사
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            // 비정상 종료된 Stale Lock 자동 회수
            fs.rmdirSync(lockPath);
            continue;
          }
        } catch (_) {}

        sleepSync(delay);
        delay = Math.min(delay * 1.5, 200);
      } else {
        return false;
      }
    }
  }

  return false;
}

/**
 * 비동기 파일 락 획득 (Promise)
 * 
 * @param {string} [lockPath=DEFAULT_LOCK_PATH]
 * @param {number} [timeoutMs=5000]
 * @param {number} [staleMs=10000]
 * @returns {Promise<boolean>}
 */
async function acquireLockAsync(lockPath = DEFAULT_LOCK_PATH, timeoutMs = 5000, staleMs = 10000) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startTime = Date.now();
  let delay = 20;

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.rmdirSync(lockPath);
            continue;
          }
        } catch (_) {}

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 200);
      } else {
        return false;
      }
    }
  }

  return false;
}

/**
 * 락 해제
 * 
 * @param {string} [lockPath=DEFAULT_LOCK_PATH]
 */
function releaseLock(lockPath = DEFAULT_LOCK_PATH) {
  try {
    if (fs.existsSync(lockPath)) {
      fs.rmdirSync(lockPath);
    }
  } catch (_) {}
}

/**
 * 락 범위 내에서 동기 함수 안전 실행
 */
function withLockSync(fn, lockPath = DEFAULT_LOCK_PATH) {
  const acquired = acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    if (acquired) {
      releaseLock(lockPath);
    }
  }
}

/**
 * 락 범위 내에서 비동기 함수 안전 실행
 */
async function withLockAsync(fn, lockPath = DEFAULT_LOCK_PATH) {
  const acquired = await acquireLockAsync(lockPath);
  try {
    return await fn();
  } finally {
    if (acquired) {
      releaseLock(lockPath);
    }
  }
}

// ============================================================================
// 2. Index Data Structures & Core Logic
// ============================================================================

/**
 * 빈 기본 인덱스 데이터 구조 생성
 * 
 * @returns {Object} 초기화된 인덱스 객체
 */
function createEmptyIndex() {
  return {
    version: 1,
    lastUpdated: null,
    corpusStats: {
      docCount: 0,
      avgDocLength: 0
    },
    mtimeMap: {},
    chunks: [],
    invertedIndex: {}
  };
}

/**
 * 디스크에서 index.json 캐시를 로드
 * 
 * @param {string} cachePath - 캐시 파일 경로
 * @returns {Object} 로드된 인덱스 객체
 */
function loadIndex(cachePath = DEFAULT_INDEX_PATH) {
  if (!fs.existsSync(cachePath)) {
    return createEmptyIndex();
  }

  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);

    // 버전 호환성 검증
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.chunks)) {
      return createEmptyIndex();
    }

    // JSON 역직렬화된 chunks의 tokenFreqs(Object)를 Map으로 복원
    for (const chunk of parsed.chunks) {
      if (chunk.tokenFreqs && !(chunk.tokenFreqs instanceof Map)) {
        chunk.tokenFreqs = new Map(Object.entries(chunk.tokenFreqs));
      }
    }

    return parsed;
  } catch (err) {
    return createEmptyIndex();
  }
}

/**
 * 인덱스 데이터를 디스크에 원자적(Atomic)으로 저장하고 SQLite 스토리지에도 동기화
 * 
 * @param {Object} indexData - 영속화할 인덱스 데이터
 * @param {string} cachePath - 대상 파일 경로
 * @param {SqliteStorage} [sqliteStorage] - 선택적 SQLite 스토리지 인스턴스
 */
function saveIndex(indexData, cachePath = DEFAULT_INDEX_PATH, sqliteStorage = null) {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // tokenFreqs가 Map인 경우 JSON 직렬화를 위해 일반 Object로 변환
  const serializedChunks = indexData.chunks.map((chunk) => {
    let tokenFreqsObj = {};
    if (chunk.tokenFreqs instanceof Map) {
      tokenFreqsObj = Object.fromEntries(chunk.tokenFreqs.entries());
    } else if (chunk.tokenFreqs && typeof chunk.tokenFreqs === 'object') {
      tokenFreqsObj = chunk.tokenFreqs;
    }

    return {
      ...chunk,
      tokenFreqs: tokenFreqsObj
    };
  });

  const payload = {
    version: indexData.version || 1,
    lastUpdated: new Date().toISOString(),
    corpusStats: indexData.corpusStats || { docCount: 0, avgDocLength: 0 },
    mtimeMap: indexData.mtimeMap || {},
    chunks: serializedChunks,
    invertedIndex: indexData.invertedIndex || {}
  };

  const tempPath = `${cachePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, cachePath);

  // SQLite 스토리지 동기화 (결함 ② 힙 메모리 폭증 방지)
  try {
    const storage = sqliteStorage || new SqliteStorage(path.resolve(dir, 'session-index.db'));
    const items = indexData.chunks.map((c) => ({
      chunk: {
        id: c.id,
        archiveFile: c.relativeKey || c.relativeFile || '',
        section: c.section || '',
        content: c.content || '',
        mtimeMs: c.mtimeMs || (indexData.mtimeMap && indexData.mtimeMap[c.relativeKey]) || 0,
        isTombstone: Boolean(c.isSuperseded)
      },
      embedding: c.vector,
      tokenFreqs: c.tokenFreqs
    }));
    storage.upsertChunksBatch(items);
    storage.setMetadata('corpusStats', payload.corpusStats);
    storage.setMetadata('lastUpdated', payload.lastUpdated);
    if (!sqliteStorage) {
      storage.close();
    }
  } catch (_) {
    // SQLite 동기화 실패 시 index.json 기본 캐시로 폴백
  }
}

/**
 * 디스크 아카이브 디렉토리 및 핸드오버 파일의 mtime 상태를 수집하고 변경 차분을 계산
 */
function scanFileChanges(options = {}, previousMtimeMap = {}) {
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : DEFAULT_ARCHIVE_DIR;
  const handoverPath = options.handoverPath ? path.resolve(options.handoverPath) : DEFAULT_HANDOVER_PATH;
  const includeCurrent = options.includeCurrentHandover !== undefined ? options.includeCurrentHandover : true;

  const currentMtimes = {};
  const targetFiles = [];

  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const fullPath = path.join(archiveDir, f);
      try {
        const stat = fs.statSync(fullPath);
        currentMtimes[f] = stat.mtimeMs;
        targetFiles.push({
          filePath: fullPath,
          relativeKey: f,
          isCurrentHandover: false
        });
      } catch (err) {}
    }
  }

  if (includeCurrent && fs.existsSync(handoverPath)) {
    try {
      const stat = fs.statSync(handoverPath);
      const key = '__CURRENT_HANDOVER__';
      currentMtimes[key] = stat.mtimeMs;
      targetFiles.push({
        filePath: handoverPath,
        relativeKey: key,
        isCurrentHandover: true
      });
    } catch (err) {}
  }

  const added = [];
  const modified = [];
  const unchanged = [];
  const deleted = [];

  for (const item of targetFiles) {
    const key = item.relativeKey;
    const currentMtime = currentMtimes[key];
    const prevMtime = previousMtimeMap[key];

    if (prevMtime === undefined) {
      added.push(item);
    } else if (prevMtime !== currentMtime) {
      modified.push(item);
    } else {
      unchanged.push(item);
    }
  }

  for (const prevKey of Object.keys(previousMtimeMap)) {
    if (currentMtimes[prevKey] === undefined) {
      deleted.push(prevKey);
    }
  }

  return {
    added,
    modified,
    deleted,
    unchanged,
    currentMtimes,
    targetFiles
  };
}

/**
 * ADR Supersedes 및 과거 폐기 결정 청크에 대한 묘비(Tombstone) 무효화 처리
 */
function applySupersedesTombstones(chunks) {
  const supersededTargets = new Set();

  for (const chunk of chunks) {
    const meta = chunk.metadata || {};
    if (meta.supersedes) {
      if (Array.isArray(meta.supersedes)) {
        for (const s of meta.supersedes) supersededTargets.add(String(s).trim().toLowerCase());
      } else {
        supersededTargets.add(String(meta.supersedes).trim().toLowerCase());
      }
    }

    const content = chunk.content || '';
    const supersedesMatches = content.match(/supersedes:\s*([a-zA-Z0-9_-]+)/gi);
    if (supersedesMatches) {
      for (const m of supersedesMatches) {
        const val = m.split(':')[1].trim().toLowerCase();
        if (val) supersededTargets.add(val);
      }
    }
  }

  if (supersededTargets.size === 0) return;

  for (const chunk of chunks) {
    const commitHash = (chunk.metadata && chunk.metadata.commitHash) ? chunk.metadata.commitHash.toLowerCase() : '';
    const relFile = (chunk.relativeFile || '').toLowerCase();
    
    let matched = false;
    for (const target of supersededTargets) {
      if (commitHash && (commitHash.startsWith(target) || target.startsWith(commitHash))) {
        matched = true;
        break;
      }
      if (relFile.includes(target)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      chunk.isSuperseded = true;
    }
  }
}

/**
 * 역색인(Inverted Index) 및 코퍼스 통계 구축
 */
function buildInvertedIndex(chunks) {
  const invertedIndex = {};
  const docCount = chunks.length;

  if (docCount === 0) {
    return {
      invertedIndex: {},
      corpusStats: { docCount: 0, avgDocLength: 0 }
    };
  }

  let totalLength = 0;

  for (const chunk of chunks) {
    totalLength += chunk.length || 0;
    const freqs = chunk.tokenFreqs instanceof Map ? chunk.tokenFreqs : new Map(Object.entries(chunk.tokenFreqs || {}));

    for (const [term, tf] of freqs.entries()) {
      if (!invertedIndex[term]) {
        invertedIndex[term] = [];
      }
      invertedIndex[term].push({
        chunkId: chunk.id,
        tf
      });
    }
  }

  const avgDocLength = totalLength / docCount;

  return {
    invertedIndex,
    corpusStats: {
      docCount,
      avgDocLength: Number(avgDocLength.toFixed(4))
    }
  };
}

/**
 * Inode mtime 기반 증분 인덱스 관리자 클래스
 */
class IndexCache {
  constructor(options = {}) {
    this.cachePath = options.cachePath ? path.resolve(options.cachePath) : DEFAULT_INDEX_PATH;
    this.lockPath = options.lockPath ? path.resolve(options.lockPath) : DEFAULT_LOCK_PATH;
    this.archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : DEFAULT_ARCHIVE_DIR;
    this.handoverPath = options.handoverPath ? path.resolve(options.handoverPath) : DEFAULT_HANDOVER_PATH;
    this.includeCurrentHandover = options.includeCurrentHandover !== undefined ? options.includeCurrentHandover : true;
    this.indexData = null;
  }

  /**
   * 캐시를 로드하거나 파일 변경을 감지하여 증분 갱신을 수행 (동시성 락 보호)
   */
  async loadOrBuild(options = {}) {
    return await withLockAsync(async () => {
      const force = Boolean(options.forceRebuild);
      let index = force ? createEmptyIndex() : loadIndex(this.cachePath);

      const scanResult = scanFileChanges({
        archiveDir: this.archiveDir,
        handoverPath: this.handoverPath,
        includeCurrentHandover: this.includeCurrentHandover
      }, index.mtimeMap || {});

      const { added, modified, deleted, unchanged, currentMtimes } = scanResult;

      if (!force && added.length === 0 && modified.length === 0 && deleted.length === 0 && index.chunks.length > 0) {
        this.indexData = index;
        return {
          ...index,
          stats: { added: 0, modified: 0, deleted: 0, unchanged: unchanged.length, cacheHit: true }
        };
      }

      // Unchanged 청크 보존
      const activeFileKeys = new Set(unchanged.map((u) => u.relativeKey));
      let retainedChunks = index.chunks.filter((chunk) => {
        const key = chunk.relativeKey || chunk.relativeFile || (chunk.metadata && chunk.metadata.isCurrentHandover ? '__CURRENT_HANDOVER__' : '');
        return activeFileKeys.has(key);
      });

      // 신규 및 수정 파일 차분 파싱
      const filesToParse = [...added, ...modified];
      const newChunks = [];

      for (const item of filesToParse) {
        try {
          const content = fs.readFileSync(item.filePath, 'utf8');
          const parsedChunks = chunkMarkdownBySections(content, {
            filePath: item.filePath,
            relativeFile: path.basename(item.filePath),
            isCurrentHandover: item.isCurrentHandover
          });

          for (const c of parsedChunks) {
            c.relativeKey = item.relativeKey;
            c.vector = null;
            c.isSuperseded = false;

            if (typeof options.embedFn === 'function') {
              try {
                c.vector = await options.embedFn(c.content);
              } catch (embedErr) {
                c.vector = null;
              }
            }

            newChunks.push(c);
          }
        } catch (readErr) {}
      }

      const allChunks = [...retainedChunks, ...newChunks];
      applySupersedesTombstones(allChunks);
      const { invertedIndex, corpusStats } = buildInvertedIndex(allChunks);

      const updatedIndex = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        corpusStats,
        mtimeMap: currentMtimes,
        chunks: allChunks,
        invertedIndex
      };

      saveIndex(updatedIndex, this.cachePath);
      this.indexData = updatedIndex;

      return {
        ...updatedIndex,
        stats: {
          added: added.length,
          modified: modified.length,
          deleted: deleted.length,
          unchanged: unchanged.length,
          cacheHit: false
        }
      };
    }, this.lockPath);
  }

  /**
   * 동기식 loadOrBuild (동시성 락 보호)
   */
  loadOrBuildSync(options = {}) {
    return withLockSync(() => {
      const force = Boolean(options.forceRebuild);
      let index = force ? createEmptyIndex() : loadIndex(this.cachePath);

      const scanResult = scanFileChanges({
        archiveDir: this.archiveDir,
        handoverPath: this.handoverPath,
        includeCurrentHandover: this.includeCurrentHandover
      }, index.mtimeMap || {});

      const { added, modified, deleted, unchanged, currentMtimes } = scanResult;

      if (!force && added.length === 0 && modified.length === 0 && deleted.length === 0 && index.chunks.length > 0) {
        this.indexData = index;
        return {
          ...index,
          stats: { added: 0, modified: 0, deleted: 0, unchanged: unchanged.length, cacheHit: true }
        };
      }

      const activeFileKeys = new Set(unchanged.map((u) => u.relativeKey));
      let retainedChunks = index.chunks.filter((chunk) => {
        const key = chunk.relativeKey || chunk.relativeFile || (chunk.metadata && chunk.metadata.isCurrentHandover ? '__CURRENT_HANDOVER__' : '');
        return activeFileKeys.has(key);
      });

      const filesToParse = [...added, ...modified];
      const newChunks = [];

      for (const item of filesToParse) {
        try {
          const content = fs.readFileSync(item.filePath, 'utf8');
          const parsedChunks = chunkMarkdownBySections(content, {
            filePath: item.filePath,
            relativeFile: path.basename(item.filePath),
            isCurrentHandover: item.isCurrentHandover
          });

          for (const c of parsedChunks) {
            c.relativeKey = item.relativeKey;
            c.vector = null;
            c.isSuperseded = false;
            newChunks.push(c);
          }
        } catch (readErr) {}
      }

      const allChunks = [...retainedChunks, ...newChunks];
      applySupersedesTombstones(allChunks);
      const { invertedIndex, corpusStats } = buildInvertedIndex(allChunks);

      const updatedIndex = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        corpusStats,
        mtimeMap: currentMtimes,
        chunks: allChunks,
        invertedIndex
      };

      saveIndex(updatedIndex, this.cachePath);
      this.indexData = updatedIndex;

      return {
        ...updatedIndex,
        stats: {
          added: added.length,
          modified: modified.length,
          deleted: deleted.length,
          unchanged: unchanged.length,
          cacheHit: false
        }
      };
    }, this.lockPath);
  }
}

module.exports = {
  DEFAULT_INDEX_PATH,
  DEFAULT_LOCK_PATH,
  acquireLockSync,
  acquireLockAsync,
  releaseLock,
  withLockSync,
  withLockAsync,
  createEmptyIndex,
  loadIndex,
  saveIndex,
  scanFileChanges,
  applySupersedesTombstones,
  buildInvertedIndex,
  IndexCache
};
