/**
 * 하이브리드 RRF (Reciprocal Rank Fusion) 융합 검색기
 * 
 * Sparse 렉시컬(BM25)과 Dense 시맨틱(multilingual-e5-small) 검색 결과를
 * 상호 순위 융합(Reciprocal Rank Fusion, k=60) 알고리즘으로 결합하여
 * 어휘 불일치(Vocabulary Mismatch)와 시맨틱 스무딩을 동시에 해결합니다.
 * ADR Supersedes 묘비(Tombstone) 감점 및 모드별 검색(hybrid, bm25, vector)을 지원합니다.
 */

const {
  BM25SearchEngine,
  normalizeSectionFilter,
  extractSnippet,
  tokenize
} = require('./search-engine');
const {
  embedText,
  cosineSimilarity
} = require('./vector-engine');
const { getDefaultWorkerClient, getDefaultWorkerPool } = require('./vector-worker');
const { IndexCache } = require('./index-cache');
const { SqliteStorage } = require('./sqlite-storage');

const DEFAULT_RRF_K = 60;

/**
 * 하이브리드 검색 엔진 클래스
 */
class HybridSearchEngine {
  constructor(options = {}) {
    this.rrfK = options.rrfK || DEFAULT_RRF_K;
    this.indexCache = options.indexCache || new IndexCache(options);
    this.chunks = [];
    this.bm25Engine = new BM25SearchEngine(options);
  }

  /**
   * 청크 목록을 등록하고 BM25 및 벡터 인덱스를 준비
   * 
   * @param {Array<Object>} chunks - 인덱싱된 청크 배열
   */
  setChunks(chunks) {
    this.chunks = chunks;
    this.bm25Engine.indexChunks(chunks);
  }

  /**
   * 캐시에서 청크를 로드하거나 증분 빌드하여 엔진 초기화
   * 
   * @param {Object} [options={}] - 빌드 옵션
   * @returns {Promise<void>}
   */
  async initialize(options = {}) {
    const workerPool = getDefaultWorkerPool();
    const embedFn = async (text) => {
      try {
        return await workerPool.embed(text, false);
      } catch (_) {
        return await embedText(text, false);
      }
    };

    const batchEmbedFn = async (texts) => {
      try {
        return await workerPool.dispatchBatch(texts);
      } catch (_) {
        return await Promise.all(texts.map((t) => embedFn(t)));
      }
    };

    const indexData = await this.indexCache.loadOrBuild({
      ...options,
      embedFn,
      batchEmbedFn
    });

    this.setChunks(indexData.chunks);

    // 벡터가 비어있는 청크가 있다면 온디맨드로 배치 임베딩 채움 (멀티 워커 병렬 가속)
    const missingChunks = this.chunks.filter((c) => !c.vector || c.vector.length === 0);
    if (missingChunks.length > 0) {
      try {
        const texts = missingChunks.map((c) => c.content);
        const vectors = await batchEmbedFn(texts);
        for (let i = 0; i < missingChunks.length; i++) {
          missingChunks[i].vector = vectors[i];
        }
      } catch (batchErr) {
        for (const chunk of missingChunks) {
          try {
            chunk.vector = await embedFn(chunk.content);
          } catch (err) {
            chunk.vector = null;
          }
        }
      }
      // 캐시 갱신
      const { saveIndex } = require('./index-cache');
      saveIndex(this.indexCache.indexData, this.indexCache.cachePath);
    }
  }

  /**
   * 하이브리드 융합 검색 수행
   * 
   * @param {string} query - 검색 질의
   * @param {Object} [options={}] - 검색 옵션
   * @param {string} [options.mode='hybrid'] - 'hybrid' | 'bm25' | 'vector'
   * @param {number} [options.limit=3] - 반환할 최대 결과 수
   * @param {string} [options.section] - 특정 섹션 필터링
   * @param {boolean} [options.excludeSuperseded=false] - 묘비 청크 완전 배제 여부
   * @returns {Promise<Array<Object>>} 융합 검색 결과 리스트
   */
  async search(query, options = {}) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return [];
    }

    const mode = (options.mode || 'hybrid').toLowerCase();
    const limit = options.limit !== undefined ? Number(options.limit) : 3;
    const sectionFilter = options.section ? normalizeSectionFilter(options.section) : null;
    const excludeSuperseded = Boolean(options.excludeSuperseded);

    // 섹션 필터링이 적용된 활성 청크 집합
    const candidateChunks = this.chunks.filter((c) => {
      if (sectionFilter && c.section !== sectionFilter) return false;
      if (excludeSuperseded && c.isSuperseded) return false;
      return true;
    });

    if (candidateChunks.length === 0) {
      return [];
    }

    // 1. BM25 순위 계산
    const queryTokens = tokenize(query);
    const bm25Results = this.bm25Engine.search(query, {
      limit: candidateChunks.length,
      section: options.section
    });

    const bm25RankMap = new Map(); // chunkKey -> rank (1-indexed)
    const bm25ScoreMap = new Map();
    bm25Results.forEach((res, idx) => {
      const key = res.id || `${res.filePath}#${res.section}`;
      bm25RankMap.set(key, idx + 1);
      bm25ScoreMap.set(key, res.score);
    });

    // 2. Vector 코사인 유사도 순위 계산 (vector 또는 hybrid 모드)
    let queryVector = null;
    const vectorScores = []; // { chunk, sim }

    if (mode === 'hybrid' || mode === 'vector') {
      try {
        const workerPool = getDefaultWorkerPool();
        queryVector = await workerPool.embed(query, true);
      } catch (err) {
        try {
          queryVector = await embedText(query, true);
        } catch (_) {
          queryVector = null;
        }
      }

      if (queryVector) {
        for (const chunk of candidateChunks) {
          if (chunk.vector && chunk.vector.length > 0) {
            const sim = cosineSimilarity(queryVector, chunk.vector);
            vectorScores.push({ chunk, sim });
          }
        }

        vectorScores.sort((a, b) => b.sim - a.sim);
      }
    }

    const vectorRankMap = new Map(); // chunkId -> rank (1-indexed)
    const vectorScoreMap = new Map();
    vectorScores.forEach((item, idx) => {
      const chunkId = item.chunk.id || `${item.chunk.filePath}#${item.chunk.section}`;
      vectorRankMap.set(chunkId, idx + 1);
      vectorScoreMap.set(chunkId, item.sim);
    });

    // 3. 모드별 랭킹 산출
    const combined = [];

    for (const chunk of candidateChunks) {
      const chunkId = chunk.id || `${chunk.filePath}#${chunk.section}`;
      const bRank = bm25RankMap.get(chunkId) || null;
      const vRank = vectorRankMap.get(chunkId) || null;
      const bScore = bm25ScoreMap.get(chunkId) || 0;
      const vScore = vectorScoreMap.get(chunkId) || 0;

      let finalScore = 0;
      let rrfScore = 0;

      if (mode === 'bm25') {
        if (bScore <= 0) continue;
        finalScore = bScore;
      } else if (mode === 'vector') {
        if (vScore <= 0) continue;
        finalScore = vScore;
      } else {
        // hybrid (RRF 융합)
        const bTerm = bRank !== null ? (1 / (this.rrfK + bRank)) : 0;
        const vTerm = vRank !== null ? (1 / (this.rrfK + vRank)) : 0;
        rrfScore = bTerm + vTerm;

        // BM25와 Vector 모두 매칭되지 않은 경우 제외
        if (bRank === null && (vRank === null || vScore < 0.65)) {
          continue;
        }

        finalScore = rrfScore;
      }

      // ADR Supersedes 묘비 감점 (-80% 페널티)
      if (chunk.isSuperseded) {
        finalScore *= 0.2;
      }

      combined.push({
        score: Number(finalScore.toFixed(6)),
        rrfScore: Number(rrfScore.toFixed(6)),
        bm25Score: bScore,
        bm25Rank: bRank,
        vectorScore: vScore,
        vectorRank: vRank,
        isSuperseded: Boolean(chunk.isSuperseded),
        file: chunk.relativeFile,
        filePath: chunk.filePath,
        section: chunk.section,
        sectionTitle: chunk.sectionTitle,
        commitHash: chunk.metadata ? chunk.metadata.commitHash : '',
        archivedAt: chunk.metadata ? chunk.metadata.archivedAt : '',
        phase: chunk.metadata ? chunk.metadata.phase : '',
        isCurrentHandover: chunk.metadata ? chunk.metadata.isCurrentHandover : false,
        content: chunk.content,
        snippet: extractSnippet(chunk.content, queryTokens.length > 0 ? queryTokens : [query], 250)
      });
    }

    // 최종 스코어 내림차순 정렬
    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, limit);
  }
}

/**
 * 터미널용 하이브리드 검색 결과 렌더링
 * 
 * @param {Array<Object>} results - 검색 결과
 * @param {string} query - 검색 질의
 * @param {string} mode - 검색 모드
 * @returns {string} 서식화된 문자열
 */
function formatHybridResults(results, query, mode = 'hybrid') {
  if (!results || results.length === 0) {
    return `[SEARCH_EMPTY] No historical records found for query: "${query}" (mode: ${mode})`;
  }

  const lines = [
    `================================================================================`,
    `  HYBRID RAG SEARCH RESULTS (Query: "${query}" | Mode: ${mode.toUpperCase()})`,
    `================================================================================`
  ];

  results.forEach((res, idx) => {
    const origin = res.isCurrentHandover
      ? '[CURRENT_HANDOVER]'
      : `[ARCHIVE: ${res.commitHash ? res.commitHash.slice(0, 7) : 'commit'}]`;
    const tombstoneTag = res.isSuperseded ? ' [SUPERSEDED_TOMBSTONE]' : '';

    let rankDetails = '';
    if (mode === 'hybrid') {
      const bRankStr = res.bm25Rank ? `#${res.bm25Rank}` : 'N/A';
      const vRankStr = res.vectorRank ? `#${res.vectorRank}` : 'N/A';
      rankDetails = ` | RRF: ${res.score} (BM25: ${bRankStr}, Vector: ${vRankStr})`;
    } else {
      rankDetails = ` | Score: ${res.score}`;
    }

    lines.push(`\n#${idx + 1}${rankDetails}${tombstoneTag} | ${origin} ${res.file}`);
    lines.push(`    Section: ${res.sectionTitle || res.section}`);
    lines.push(`    Snippet: ${res.snippet}`);
  });

  lines.push(`\n================================================================================`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_RRF_K,
  HybridSearchEngine,
  formatHybridResults
};
