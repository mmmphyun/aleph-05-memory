/**
 * Node.js 내장 node:sqlite(DatabaseSync) 기반 경량 임베디드 세션 스토리지 모듈
 * 
 * 단일 거대 JSON(.session-memory/index.json) 역직렬화로 인한 V8 힙 메모리 폭증(O(N))을 해소하고,
 * B-Tree 인덱스 및 WAL(Write-Ahead Logging) 모드를 통해 온디맨드 디스크 룩업과
 * 프로세스 간 읽기/쓰기 동시성을 보장합니다.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.session-memory', 'session-index.db');

class SqliteStorage {
  /**
   * @param {string} [dbPath] - SQLite 데이터베이스 파일 경로
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = path.resolve(dbPath);
    this.db = null;
    this._initDatabase();
  }

  /**
   * 디렉토리 생성, DB 파일 오픈 및 WAL 모드/테이블 스키마 초기화
   * @private
   */
  _initDatabase() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    // WAL 모드 활성화 (동시 읽기 및 쓰기 성능 최적화)
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    // 테이블 스키마 초기화
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        archive_file TEXT NOT NULL,
        section TEXT NOT NULL,
        content TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        is_tombstone INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_archive ON chunks(archive_file);
      CREATE INDEX IF NOT EXISTS idx_chunks_section ON chunks(section);

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inverted_index (
        term TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY (term, chunk_id),
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_inverted_term ON inverted_index(term);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * 단일 청크, 임베딩 벡터 및 역색인 텀을 원자적 트랜잭션으로 저장
   * 
   * @param {Object} chunk - 청크 정보
   * @param {Float32Array|Array<number>} [embedding] - 384차원 임베딩 벡터
   * @param {Map<string, number>|Object} [tokenFreqs] - 단어 빈도
   */
  upsertChunk(chunk, embedding = null, tokenFreqs = null) {
    this.upsertChunksBatch([{ chunk, embedding, tokenFreqs }]);
  }

  /**
   * 복수 청크 및 임베딩을 단일 배치 트랜잭션으로 저장 (WAL 최적화)
   * 
   * @param {Array<{chunk: Object, embedding?: Float32Array, tokenFreqs?: Map|Object}>} items
   */
  upsertChunksBatch(items) {
    if (!items || items.length === 0) return;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const stmtChunk = this.db.prepare(`
        INSERT INTO chunks (id, archive_file, section, content, mtime_ms, is_tombstone)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          archive_file = excluded.archive_file,
          section = excluded.section,
          content = excluded.content,
          mtime_ms = excluded.mtime_ms,
          is_tombstone = excluded.is_tombstone;
      `);

      const stmtEmbed = this.db.prepare(`
        INSERT INTO embeddings (chunk_id, dim, vector)
        VALUES (?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          dim = excluded.dim,
          vector = excluded.vector;
      `);

      const stmtDeleteTerms = this.db.prepare(`
        DELETE FROM inverted_index WHERE chunk_id = ?;
      `);

      const stmtInsertTerm = this.db.prepare(`
        INSERT INTO inverted_index (term, chunk_id, tf)
        VALUES (?, ?, ?);
      `);

      for (const item of items) {
        const { chunk, embedding, tokenFreqs } = item;
        const isTombstone = chunk.isTombstone ? 1 : 0;

        stmtChunk.run(
          chunk.id,
          chunk.archiveFile || chunk.file || '',
          chunk.section || '',
          chunk.content || '',
          Number(chunk.mtimeMs || chunk.mtime || 0),
          isTombstone
        );

        if (embedding && embedding.length > 0) {
          // Float32Array 버퍼를 Node.js Uint8Array Buffer로 변환하여 BLOB 저장
          const floatArray = (embedding instanceof Float32Array)
            ? embedding
            : new Float32Array(embedding);
          const buffer = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
          stmtEmbed.run(chunk.id, floatArray.length, buffer);
        }

        if (tokenFreqs) {
          stmtDeleteTerms.run(chunk.id);
          const entries = (tokenFreqs instanceof Map)
            ? tokenFreqs.entries()
            : Object.entries(tokenFreqs);

          for (const [term, tf] of entries) {
            if (term && Number(tf) > 0) {
              stmtInsertTerm.run(String(term), chunk.id, Number(tf));
            }
          }
        }
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /**
   * 특정 아카이브 파일에 속한 모든 청크 삭제 (외래 키 CASCADE로 연관 임베딩/역색인 자동 제거)
   * 
   * @param {string} archiveFile - 대상 아카이브 파일명 또는 상대경로
   * @returns {number} 삭제된 청크 개수
   */
  deleteChunksByFile(archiveFile) {
    const stmt = this.db.prepare('DELETE FROM chunks WHERE archive_file = ?;');
    const result = stmt.run(archiveFile);
    return result.changes;
  }

  /**
   * 단일 청크 상세 조회
   * 
   * @param {string} chunkId - 청크 고유 ID
   * @returns {Object|null}
   */
  getChunk(chunkId) {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE id = ?;');
    const row = stmt.get(chunkId);
    if (!row) return null;

    return {
      id: row.id,
      archiveFile: row.archive_file,
      section: row.section,
      content: row.content,
      mtimeMs: row.mtime_ms,
      isTombstone: Boolean(row.is_tombstone)
    };
  }

  /**
   * 저장된 전체 청크 목록 조회
   * 
   * @param {Object} [filter] - 필터 옵션
   * @param {string} [filter.section] - 특정 섹션 필터
   * @returns {Array<Object>}
   */
  getAllChunks(filter = {}) {
    let sql = 'SELECT * FROM chunks';
    const params = [];

    if (filter.section) {
      sql += ' WHERE section = ?';
      params.push(filter.section);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map((row) => ({
      id: row.id,
      archiveFile: row.archive_file,
      section: row.section,
      content: row.content,
      mtimeMs: row.mtime_ms,
      isTombstone: Boolean(row.is_tombstone)
    }));
  }

  /**
   * 저장된 모든 임베딩 벡터를 Float32Array로 복원하여 반환
   * 
   * @returns {Map<string, Float32Array>} chunkId ➔ Float32Array 매핑
   */
  getAllEmbeddings() {
    const stmt = this.db.prepare('SELECT chunk_id, dim, vector FROM embeddings;');
    const rows = stmt.all();
    const map = new Map();

    for (const row of rows) {
      const buffer = row.vector;
      // Buffer에서 Float32Array 뷰 생성 (Zero-copy)
      const floatArray = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        row.dim
      );
      // 안전한 메모리 참조를 위해 slice 복제본 저장
      map.set(row.chunk_id, new Float32Array(floatArray));
    }

    return map;
  }

  /**
   * 단일 청크의 임베딩 벡터 조회
   * 
   * @param {string} chunkId
   * @returns {Float32Array|null}
   */
  getEmbedding(chunkId) {
    const stmt = this.db.prepare('SELECT dim, vector FROM embeddings WHERE chunk_id = ?;');
    const row = stmt.get(chunkId);
    if (!row) return null;

    const buffer = row.vector;
    const floatArray = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      row.dim
    );
    return new Float32Array(floatArray);
  }

  /**
   * 주어진 쿼리 벡터와 저장된 모든 청크 임베딩 간의 코사인 유사도 랭킹 산출
   * 
   * @param {Float32Array|Array<number>} queryVec - L2 정규화된 384차원 쿼리 벡터
   * @param {Object} [options]
   * @param {number} [options.limit=10] - 반환할 최대 결과 수
   * @param {string} [options.section] - 특정 섹션 필터링
   * @returns {Array<{chunkId: string, score: number, chunk: Object}>}
   */
  searchCosine(queryVec, options = {}) {
    const limit = options.limit || 10;
    const section = options.section || null;

    let sql = `
      SELECT c.id, c.archive_file, c.section, c.content, c.mtime_ms, c.is_tombstone,
             e.dim, e.vector
      FROM chunks c
      JOIN embeddings e ON c.id = e.chunk_id
    `;
    const params = [];

    if (section) {
      sql += ' WHERE c.section = ?';
      params.push(section);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    const qLen = queryVec.length;
    const scored = [];

    for (const row of rows) {
      const buffer = row.vector;
      const docVec = new Float32Array(buffer.buffer, buffer.byteOffset, row.dim);

      let dotProduct = 0;
      for (let i = 0; i < qLen; i++) {
        dotProduct += queryVec[i] * docVec[i];
      }

      scored.push({
        chunkId: row.id,
        score: Number(dotProduct.toFixed(6)),
        chunk: {
          id: row.id,
          archiveFile: row.archive_file,
          section: row.section,
          content: row.content,
          mtimeMs: row.mtime_ms,
          isTombstone: Boolean(row.is_tombstone)
        }
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * 지정된 단어(term)들에 매칭되는 역색인 항목 조회
   * 
   * @param {Array<string>} terms - 검색어 토큰 목록
   * @returns {Array<{term: string, chunkId: string, tf: number}>}
   */
  searchInvertedIndex(terms) {
    if (!terms || terms.length === 0) return [];

    const placeholders = terms.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT term, chunk_id, tf
      FROM inverted_index
      WHERE term IN (${placeholders});
    `);

    const rows = stmt.all(...terms);
    return rows.map((r) => ({
      term: r.term,
      chunkId: r.chunk_id,
      tf: r.tf
    }));
  }

  /**
   * 메타데이터 키-값 저장
   * 
   * @param {string} key
   * @param {string|Object} value
   */
  setMetadata(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const stmt = this.db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
    stmt.run(key, strVal);
  }

  /**
   * 메타데이터 키 조회
   * 
   * @param {string} key
   * @param {boolean} [asJson=false]
   * @returns {any}
   */
  getMetadata(key, asJson = false) {
    const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?;');
    const row = stmt.get(key);
    if (!row) return null;

    if (asJson) {
      try {
        return JSON.parse(row.value);
      } catch (_) {
        return null;
      }
    }
    return row.value;
  }

  /**
   * 현재 인덱스 통계 정보 요약
   * 
   * @returns {{chunkCount: number, embeddingCount: number, termCount: number}}
   */
  getStats() {
    const chunkRow = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks;').get();
    const embedRow = this.db.prepare('SELECT COUNT(*) as cnt FROM embeddings;').get();
    const termRow = this.db.prepare('SELECT COUNT(DISTINCT term) as cnt FROM inverted_index;').get();

    return {
      chunkCount: chunkRow.cnt,
      embeddingCount: embedRow.cnt,
      termCount: termRow.cnt
    };
  }

  /**
   * DB 연결 명시적 해제
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  SqliteStorage
};
