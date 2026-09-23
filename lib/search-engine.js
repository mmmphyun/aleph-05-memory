/**
 * 로컬 Zero-Dependency BM25 렉시컬 검색 엔진
 * 과거 세션 아카이브(.session-memory/archives/*.md) 및 현재 HANDOVER.md를 대상으로
 * 개발 도메인 특화 토크나이징 및 BM25 랭킹 알고리즘 기반 고속 검색(5ms 이내)을 수행합니다.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ARCHIVE_DIR = path.resolve(process.cwd(), '.session-memory', 'archives');
const DEFAULT_HANDOVER_PATH = path.resolve(process.cwd(), 'HANDOVER.md');

const MANDATORY_SECTIONS = [
  '목표',
  '현재 상태',
  '실행 명령',
  '통과 검사',
  '남은 문제',
  '다음 행동',
  '건드리지 말 것'
];

const SECTION_ALIAS_MAP = {
  '1': '목표', 'goal': '목표', 'goals': '목표', '목표': '목표',
  '2': '현재 상태', 'status': '현재 상태', '현재 상태': '현재 상태', '현재상태': '현재 상태',
  '3': '실행 명령', 'command': '실행 명령', 'commands': '실행 명령', '실행 명령': '실행 명령', '실행명령': '실행 명령',
  '4': '통과 검사', 'passed': '통과 검사', 'pass': '통과 검사', 'test': '통과 검사', 'tests': '통과 검사', '통과 검사': '통과 검사', '통과검사': '통과 검사',
  '5': '남은 문제', 'issues': '남은 문제', 'issue': '남은 문제', '남은 문제': '남은 문제', '남은문제': '남은 문제',
  '6': '다음 행동', 'next': '다음 행동', 'action': '다음 행동', 'actions': '다음 행동', '다음 행동': '다음 행동', '다음행동': '다음 행동',
  '7': '건드리지 말 것', 'prohibited': '건드리지 말 것', 'scope': '건드리지 말 것', '건드리지 말 것': '건드리지 말 것', '건드리지말것': '건드리지 말 것'
};

/**
 * 프론트매터 파싱 (YAML 스타일 키-값 파싱)
 */
function parseFrontmatter(rawContent) {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = rawContent.match(frontmatterRegex);

  if (!match) {
    return {
      metadata: {},
      body: rawContent
    };
  }

  const yamlBlock = match[1];
  const body = rawContent.slice(match[0].length);
  const metadata = {};

  const lines = yamlBlock.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      if (key === 'pass_count' || key === 'fail_count') {
        value = Number(value) || 0;
      } else if (key === 'tags') {
        value = value ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
      }
      metadata[key] = value;
    }
  }

  return { metadata, body };
}

/**
 * 개발 도메인 특화 토크나이저
 * - CamelCase 분리 (예: SearchEngine -> [searchengine, search, engine])
 * - snake_case / kebab-case 분리 (예: search-engine -> [search-engine, search, engine])
 * - 파일 경로 및 확장자 보존 (예: lib/search-engine.js, .js, .py)
 * - HTTP 에러 코드 및 숫자 보존 (예: 429, 401)
 * - Git Commit SHA-1 보존 (7~40자리 Hex)
 * - 한국어 및 영문 토큰 정규화
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  const tokens = [];
  // 1. 공백 및 특수 구두점으로 대략 분할
  const rawSegments = text.split(/[\s,;()[\]{}<>"'`|\\]+/);

  for (const rawSeg of rawSegments) {
    const seg = rawSeg.trim();
    if (!seg || seg.length < 2) continue;

    const lower = seg.toLowerCase();
    tokens.push(lower);

    // Git Commit Hash 보존 (7~40자리 16진수)
    if (/^[0-9a-f]{7,40}$/i.test(seg)) {
      tokens.push(lower.slice(0, 7));
    }

    // 파일 경로 및 확장자 추출
    if (seg.includes('/') || seg.includes('.')) {
      const extMatch = seg.match(/\.([a-zA-Z0-9]+)$/);
      if (extMatch) {
        tokens.push(`.${extMatch[1].toLowerCase()}`);
      }
      const parts = seg.split(/[/.]+/).filter((p) => p.length >= 2);
      for (const p of parts) {
        tokens.push(p.toLowerCase());
      }
    }

    // CamelCase 분리
    const camelParts = seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    if (camelParts.length > 1) {
      for (const cp of camelParts) {
        if (cp.length >= 2) tokens.push(cp.toLowerCase());
      }
    }

    // snake_case / kebab-case 분리
    if (seg.includes('_') || seg.includes('-')) {
      const subParts = seg.split(/[_-]+/).filter((p) => p.length >= 2);
      for (const sp of subParts) {
        tokens.push(sp.toLowerCase());
      }
    }
  }

  return tokens;
}

/**
 * 마크다운 본문을 H1 섹션 단위 청크로 분할
 */
function chunkMarkdownBySections(markdown, sourceInfo = {}) {
  const { metadata, body } = parseFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const chunks = [];

  let currentSection = null;
  let currentSectionTitle = '';
  let buffer = [];
  let inCodeBlock = false;

  function commitCurrentChunk() {
    if (currentSection && buffer.length > 0) {
      const content = buffer.join('\n').trim();
      if (content.length > 0) {
        const tokens = tokenize(content);
        const tokenFreqs = new Map();
        for (const t of tokens) {
          tokenFreqs.set(t, (tokenFreqs.get(t) || 0) + 1);
        }

        chunks.push({
          id: `${sourceInfo.filePath}#${currentSection}`,
          filePath: sourceInfo.filePath,
          relativeFile: sourceInfo.relativeFile || path.basename(sourceInfo.filePath),
          section: currentSection,
          sectionTitle: currentSectionTitle,
          content,
          metadata: {
            ...metadata,
            commitHash: metadata.commit_hash || sourceInfo.commitHash || '',
            archivedAt: metadata.archived_at || sourceInfo.archivedAt || '',
            phase: metadata.phase || sourceInfo.phase || 'UNKNOWN',
            isCurrentHandover: Boolean(sourceInfo.isCurrentHandover)
          },
          tokens,
          tokenFreqs,
          length: tokens.length
        });
      }
    }
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    const h1Match = !inCodeBlock && line.match(/^#\s*(?:\d+\.\s*)?([^\n\r]+)/);
    if (h1Match) {
      commitCurrentChunk();
      const rawTitle = h1Match[1].trim();
      const matchedCanonical = MANDATORY_SECTIONS.find((sec) => rawTitle.includes(sec));
      currentSection = matchedCanonical || rawTitle;
      currentSectionTitle = line.trim();
      buffer = [];
    } else {
      if (currentSection) {
        buffer.push(line);
      }
    }
  }

  commitCurrentChunk();
  return chunks;
}

/**
 * 인덱싱된 청크 코퍼스에서 BM25 검색을 수행하는 엔진 클래스
 */
class BM25SearchEngine {
  constructor(options = {}) {
    this.k1 = options.k1 !== undefined ? options.k1 : 1.2;
    this.b = options.b !== undefined ? options.b : 0.75;
    this.chunks = [];
    this.docCount = 0;
    this.avgDocLength = 0;
    this.docFreqs = new Map(); // term -> count of docs containing term
    this.idfCache = new Map();
  }

  /**
   * 청크 목록을 코퍼스에 등록하고 통계 인덱스를 구축
   */
  indexChunks(chunks) {
    this.chunks = chunks;
    this.docCount = chunks.length;
    this.docFreqs.clear();
    this.idfCache.clear();

    if (this.docCount === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
      const seenTerms = new Set(chunk.tokenFreqs.keys());
      for (const term of seenTerms) {
        this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1);
      }
    }

    this.avgDocLength = totalLength / this.docCount;

    // IDF 사전 계산
    for (const [term, n] of this.docFreqs.entries()) {
      const idf = Math.log((this.docCount - n + 0.5) / (n + 0.5) + 1);
      this.idfCache.set(term, Math.max(0, idf));
    }
  }

  /**
   * 쿼리에 대한 BM25 연관도 스코어 계산 및 검색
   */
  search(query, options = {}) {
    const limit = options.limit !== undefined ? options.limit : 3;
    const sectionFilter = options.section ? normalizeSectionFilter(options.section) : null;

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docCount === 0) {
      return [];
    }

    const scored = [];

    for (const chunk of this.chunks) {
      if (sectionFilter && chunk.section !== sectionFilter) {
        continue;
      }

      let score = 0;
      const docLen = chunk.length;
      const lenNorm = 1 - this.b + this.b * (this.avgDocLength > 0 ? (docLen / this.avgDocLength) : 1);

      for (const qToken of queryTokens) {
        const tf = chunk.tokenFreqs.get(qToken) || 0;
        if (tf === 0) continue;

        const idf = this.idfCache.get(qToken) || 0;
        const num = tf * (this.k1 + 1);
        const denom = tf + this.k1 * lenNorm;
        score += idf * (num / denom);
      }

      if (score > 0) {
        scored.push({
          score: Number(score.toFixed(4)),
          file: chunk.relativeFile,
          filePath: chunk.filePath,
          section: chunk.section,
          sectionTitle: chunk.sectionTitle,
          commitHash: chunk.metadata.commitHash,
          archivedAt: chunk.metadata.archivedAt,
          phase: chunk.metadata.phase,
          isCurrentHandover: chunk.metadata.isCurrentHandover,
          content: chunk.content,
          snippet: extractSnippet(chunk.content, queryTokens, 250)
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

/**
 * 섹션 필터 이름 정규화 (1 -> '목표', 'next' -> '다음 행동' 등)
 */
function normalizeSectionFilter(filter) {
  if (!filter) return null;
  const key = String(filter).trim().toLowerCase();
  return SECTION_ALIAS_MAP[key] || filter;
}

/**
 * 쿼리 토큰 주변의 본문 스니펫(Snippet) 추출
 */
function extractSnippet(content, queryTokens, maxChars = 200) {
  if (!content) return '';
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  const lowerTokens = queryTokens.map((t) => t.toLowerCase());

  // 쿼리 토큰과 가장 많이 겹치는 라인 찾기
  let bestLineIdx = 0;
  let maxMatches = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let matches = 0;
    for (const t of lowerTokens) {
      if (lineLower.includes(t)) matches++;
    }
    if (matches > maxMatches) {
      maxMatches = matches;
      bestLineIdx = i;
    }
  }

  const selectedSnippet = lines.slice(bestLineIdx, bestLineIdx + 4).join(' ');
  if (selectedSnippet.length <= maxChars) {
    return selectedSnippet;
  }
  return selectedSnippet.slice(0, maxChars) + '...';
}

/**
 * 로컬 파일 시스템에서 아카이브 및 현재 핸드오버 파일들을 스캔하여 청크 집합 생성
 */
function loadAllChunks(options = {}) {
  const rootDir = process.cwd();
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : DEFAULT_ARCHIVE_DIR;
  const handoverPath = options.handoverPath ? path.resolve(options.handoverPath) : DEFAULT_HANDOVER_PATH;
  const includeCurrent = options.includeCurrentHandover !== undefined ? options.includeCurrentHandover : true;

  const allChunks = [];

  // 1. 아카이브 디렉토리 스캔 (.session-memory/archives/*.md)
  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const fullPath = path.join(archiveDir, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const chunks = chunkMarkdownBySections(content, {
          filePath: fullPath,
          relativeFile: path.relative(rootDir, fullPath),
          isCurrentHandover: false
        });
        allChunks.push(...chunks);
      } catch (err) {
        // 읽기 오류 시 건너뜀
      }
    }
  }

  // 2. 현재 작업 트리 HANDOVER.md 스캔
  if (includeCurrent && fs.existsSync(handoverPath)) {
    try {
      const content = fs.readFileSync(handoverPath, 'utf8');
      const chunks = chunkMarkdownBySections(content, {
        filePath: handoverPath,
        relativeFile: path.relative(rootDir, handoverPath),
        isCurrentHandover: true
      });
      allChunks.push(...chunks);
    } catch (err) {
      // 읽기 오류 시 건너뜀
    }
  }

  return allChunks;
}

/**
 * 터미널용 검색 결과 마크다운 렌더링
 */
function formatSearchResults(results, query) {
  if (!results || results.length === 0) {
    return `[SEARCH_EMPTY] No historical records found for query: "${query}"`;
  }

  const lines = [
    `================================================================================`,
    `  SESSION MEMORY BM25 SEARCH RESULTS (Query: "${query}")`,
    `================================================================================`
  ];

  results.forEach((res, idx) => {
    const origin = res.isCurrentHandover ? '[CURRENT_HANDOVER]' : `[ARCHIVE: ${res.commitHash ? res.commitHash.slice(0, 7) : 'commit'}]`;
    lines.push(`\n#${idx + 1} Score: ${res.score} | ${origin} ${res.file}`);
    lines.push(`    Section: ${res.sectionTitle || res.section}`);
    lines.push(`    Snippet: ${res.snippet}`);
  });

  lines.push(`\n================================================================================`);
  return lines.join('\n');
}

/**
 * CLI search 명령 실행기
 */
function executeSearch(options = {}) {
  const query = options.query;
  if (!query || typeof query !== 'string' || query.trim() === '') {
    console.error("Error: Missing --query <TEXT>");
    process.exit(1);
  }

  const chunks = loadAllChunks(options);
  const engine = new BM25SearchEngine(options);
  engine.indexChunks(chunks);

  const results = engine.search(query, {
    limit: options.limit ? Number(options.limit) : 3,
    section: options.section
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return results;
  }

  const output = formatSearchResults(results, query);
  console.log(output);
  return results;
}

module.exports = {
  DEFAULT_ARCHIVE_DIR,
  DEFAULT_HANDOVER_PATH,
  MANDATORY_SECTIONS,
  SECTION_ALIAS_MAP,
  parseFrontmatter,
  tokenize,
  chunkMarkdownBySections,
  BM25SearchEngine,
  normalizeSectionFilter,
  extractSnippet,
  loadAllChunks,
  formatSearchResults,
  executeSearch
};
