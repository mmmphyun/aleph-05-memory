/**
 * Inode mtime 기반 로컬 증분 색인(Incremental Index) 영속화 모듈
 * 
 * 과거 세션 아카이브(.session-memory/archives/*.md) 및 작업 트리 HANDOVER.md의
 * 파일 수정 시간(mtimeMs)을 추적하여 변경된 파일(O(Δ))만 차분 파싱/인덱싱하고,
 * .session-memory/index.json에 캐시를 영속화하여 O(1) 수준의 고속 검색 로딩을 보장합니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_ARCHIVE_DIR,
  DEFAULT_HANDOVER_PATH,
  chunkMarkdownBySections,
  tokenize
} = require('./search-engine');

const DEFAULT_INDEX_PATH = path.resolve(process.cwd(), '.session-memory', 'index.json');

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
 * 파일 부재 또는 JSON 파싱 오류 발생 시 손상 회복을 위해 빈 인덱스를 반환합니다.
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

    // JSON 역직렬화된 chunks의 tokenFreqs(Object)를 Map으로 복원하여 SearchEngine 호환성 보장
    for (const chunk of parsed.chunks) {
      if (chunk.tokenFreqs && !(chunk.tokenFreqs instanceof Map)) {
        chunk.tokenFreqs = new Map(Object.entries(chunk.tokenFreqs));
      }
    }

    return parsed;
  } catch (err) {
    // 손상된 JSON 캐시 발견 시 경고 후 빈 인덱스로 폴백 (자기 치유)
    return createEmptyIndex();
  }
}

/**
 * 인덱스 데이터를 디스크에 원자적(Atomic)으로 저장
 * 동시 쓰기 또는 프로세스 비정상 종료 시 파일 손상을 방지하기 위해 임시 파일(.tmp) 작성 후 rename을 수행합니다.
 * 
 * @param {Object} indexData - 영속화할 인덱스 데이터
 * @param {string} cachePath - 대상 파일 경로
 */
function saveIndex(indexData, cachePath = DEFAULT_INDEX_PATH) {
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
}

/**
 * 디스크 아카이브 디렉토리 및 핸드오버 파일의 mtime 상태를 수집하고 변경 차분을 계산
 * 
 * @param {Object} options - 스캔 옵션
 * @param {string} options.archiveDir - 아카이브 디렉토리 경로
 * @param {string} options.handoverPath - HANDOVER.md 경로
 * @param {boolean} options.includeCurrentHandover - HANDOVER.md 포함 여부
 * @param {Object} previousMtimeMap - 기존 캐시의 mtimeMap
 * @returns {Object} { added, modified, deleted, unchanged, currentMtimes, targetFiles }
 */
function scanFileChanges(options = {}, previousMtimeMap = {}) {
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : DEFAULT_ARCHIVE_DIR;
  const handoverPath = options.handoverPath ? path.resolve(options.handoverPath) : DEFAULT_HANDOVER_PATH;
  const includeCurrent = options.includeCurrentHandover !== undefined ? options.includeCurrentHandover : true;

  const currentMtimes = {};
  const targetFiles = []; // { filePath, relativeKey, isCurrentHandover }

  // 1. 아카이브 파일 수집
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
      } catch (err) {
        // I/O 경쟁 상태 발생 시 제외
      }
    }
  }

  // 2. 작업 트리 HANDOVER.md 수집
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
    } catch (err) {
      // I/O 오류 시 제외
    }
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
 * 
 * - metadata.supersedes 또는 본문 내용의 "[폐기]:", "supersedes:" 지시어를 감지하여
 *   이전 세션의 관련 청크에 isSuperseded = true 마킹
 * 
 * @param {Array<Object>} chunks - 전체 청크 배열
 */
function applySupersedesTombstones(chunks) {
  const supersededTargets = new Set();

  for (const chunk of chunks) {
    const meta = chunk.metadata || {};
    // 메타데이터 프론트매터의 supersedes
    if (meta.supersedes) {
      if (Array.isArray(meta.supersedes)) {
        for (const s of meta.supersedes) supersededTargets.add(String(s).trim().toLowerCase());
      } else {
        supersededTargets.add(String(meta.supersedes).trim().toLowerCase());
      }
    }

    // 본문 내 ADR 폐기 대상 해시/키워드 추출
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
    
    // 타겟 커밋 해시나 파일명이 supersededTargets에 매핑되면 묘비 마킹
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
 * 청크 배열로부터 역색인(Inverted Index) 및 코퍼스 통계 구축
 * 
 * @param {Array<Object>} chunks - 청크 배열
 * @returns {Object} { invertedIndex, corpusStats }
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
    this.archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : DEFAULT_ARCHIVE_DIR;
    this.handoverPath = options.handoverPath ? path.resolve(options.handoverPath) : DEFAULT_HANDOVER_PATH;
    this.includeCurrentHandover = options.includeCurrentHandover !== undefined ? options.includeCurrentHandover : true;
    this.indexData = null;
  }

  /**
   * 캐시를 로드하거나 파일 변경을 감지하여 증분 갱신을 수행
   * 
   * @param {Object} options - 빌드 옵션
   * @param {Function} [options.embedFn] - 신규 청크에 대한 선택적 벡터 임베딩 생성기
   * @param {boolean} [options.forceRebuild] - 강제 전체 재색인 플래그
   * @returns {Promise<Object>|Object} 갱신된 인덱스 객체 { corpusStats, invertedIndex, mtimeMap, chunks, stats }
   */
  async loadOrBuild(options = {}) {
    const force = Boolean(options.forceRebuild);
    let index = force ? createEmptyIndex() : loadIndex(this.cachePath);

    const scanResult = scanFileChanges({
      archiveDir: this.archiveDir,
      handoverPath: this.handoverPath,
      includeCurrentHandover: this.includeCurrentHandover
    }, index.mtimeMap || {});

    const { added, modified, deleted, unchanged, currentMtimes } = scanResult;

    // 변경 사항이 없고 기존 인덱스가 유효하면 디스크 I/O 없이 즉시 반환
    if (!force && added.length === 0 && modified.length === 0 && deleted.length === 0 && index.chunks.length > 0) {
      this.indexData = index;
      return {
        ...index,
        stats: { added: 0, modified: 0, deleted: 0, unchanged: unchanged.length, cacheHit: true }
      };
    }

    // 1. Unchanged 파일의 기존 청크 보존 (삭제 및 수정 대상 파일의 청크 제거)
    const activeFileKeys = new Set(unchanged.map((u) => u.relativeKey));
    let retainedChunks = index.chunks.filter((chunk) => {
      const key = chunk.relativeKey || chunk.relativeFile || (chunk.metadata && chunk.metadata.isCurrentHandover ? '__CURRENT_HANDOVER__' : '');
      return activeFileKeys.has(key);
    });

    // 2. 신규(Added) 및 수정(Modified) 파일 차분 파싱
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

          // 비동기 임베딩 생성기가 제공된 경우 즉시 바인딩
          if (typeof options.embedFn === 'function') {
            try {
              c.vector = await options.embedFn(c.content);
            } catch (embedErr) {
              c.vector = null;
            }
          }

          newChunks.push(c);
        }
      } catch (readErr) {
        // 파일 읽기 실패 시 건너뜀
      }
    }

    const allChunks = [...retainedChunks, ...newChunks];

    // 3. ADR Supersedes 묘비 무효화 적용
    applySupersedesTombstones(allChunks);

    // 4. 역색인 및 통계 재구축
    const { invertedIndex, corpusStats } = buildInvertedIndex(allChunks);

    const updatedIndex = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      corpusStats,
      mtimeMap: currentMtimes,
      chunks: allChunks,
      invertedIndex
    };

    // 5. 디스크 영속화
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
  }

  /**
   * 동기식 loadOrBuild (embedFn이 불필요한 고속 BM25/캐시 워밍용)
   */
  loadOrBuildSync(options = {}) {
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
      } catch (readErr) {
        // 읽기 오류 무시
      }
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
  }
}

module.exports = {
  DEFAULT_INDEX_PATH,
  createEmptyIndex,
  loadIndex,
  saveIndex,
  scanFileChanges,
  applySupersedesTombstones,
  buildInvertedIndex,
  IndexCache
};
