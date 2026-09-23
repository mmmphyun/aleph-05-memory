/**
 * Zero-dependency Notion REST API 클라이언트
 * node:https / node:http 기반, 429 Rate-Limit 지수 백오프 지원
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const NOTION_API_VERSION = '2022-06-28';
const DEFAULT_NOTION_BASE_URL = 'https://api.notion.com';

class NotionClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {number} [options.maxRetries]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.NOTION_API_KEY || '');
    this.baseUrl = options.baseUrl || DEFAULT_NOTION_BASE_URL;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
  }

  /**
   * HTTP 요청 전송 (429 Retry-After 처리 포함)
   * @private
   */
  async _request(method, endpoint, body = null, attempt = 0) {
    if (!this.apiKey) {
      const err = new Error('[AUTH_ERROR] NOTION_API_KEY is not set in environment');
      err.code = 'ERR_AUTH_MISSING';
      throw err;
    }

    const fullUrl = new URL(endpoint, this.baseUrl);
    const isHttps = fullUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json'
    };

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const requestOptions = {
      method,
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      headers
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', async () => {
          // HTTP 429 Rate Limit 처리
          if (res.statusCode === 429) {
            if (attempt < this.maxRetries) {
              const retryAfterHeader = res.headers['retry-after'];
              const retryDelaySec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 1;
              const delayMs = Math.max(100, retryDelaySec * 1000);

              console.log(`[RETRY] HTTP 429 detected. Backing off for ${delayMs}ms... (attempt ${attempt + 1}/${this.maxRetries})`);
              await new Promise((r) => setTimeout(r, delayMs));
              try {
                const retryRes = await this._request(method, endpoint, body, attempt + 1);
                return resolve(retryRes);
              } catch (retryErr) {
                return reject(retryErr);
              }
            } else {
              const err = new Error(`[RATE_LIMIT_ERROR] Exceeded max retries for 429 Too Many Requests`);
              err.statusCode = 429;
              return reject(err);
            }
          }

          let parsedJson;
          try {
            parsedJson = responseData ? JSON.parse(responseData) : {};
          } catch {
            parsedJson = { raw: responseData };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data: parsedJson });
          } else {
            const err = new Error(`[NOTION_API_ERROR] HTTP ${res.statusCode}: ${parsedJson.message || responseData}`);
            err.statusCode = res.statusCode;
            err.details = parsedJson;
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /**
   * 데이터베이스 스키마 생성: POST /v1/databases
   */
  async createDatabase(parentPageId, schema) {
    const body = {
      parent: { type: 'page_id', page_id: parentPageId },
      title: schema.title || [{ type: 'text', text: { content: 'Agent Session Memory DB' } }],
      properties: schema.properties
    };
    return this._request('POST', '/v1/databases', body);
  }

  /**
   * 새 페이지(세션 레코드) 생성: POST /v1/pages
   * 100개 블록 초과 시 최초 100개 주입 후 나머지는 PATCH로 순차 append
   */
  async createPage(databaseId, properties, childrenBlocks = []) {
    const MAX_BLOCKS = 100;
    const initialBlocks = childrenBlocks.slice(0, MAX_BLOCKS);
    const remainingBlocks = childrenBlocks.slice(MAX_BLOCKS);

    const body = {
      parent: { database_id: databaseId },
      properties,
      children: initialBlocks
    };

    const res = await this._request('POST', '/v1/pages', body);
    const pageId = res.data && res.data.id;

    // 100개 초과 블록 순차 추가
    if (pageId && remainingBlocks.length > 0) {
      for (let i = 0; i < remainingBlocks.length; i += MAX_BLOCKS) {
        const batch = remainingBlocks.slice(i, i + MAX_BLOCKS);
        await this.appendBlockChildren(pageId, batch);
      }
    }

    return res;
  }

  /**
   * 블록 자식 추가: PATCH /v1/blocks/{id}/children
   */
  async appendBlockChildren(blockId, childrenBlocks) {
    const body = { children: childrenBlocks };
    return this._request('PATCH', `/v1/blocks/${blockId}/children`, body);
  }

  /**
   * 데이터베이스 쿼리: POST /v1/databases/{id}/query
   */
  async queryDatabase(databaseId, queryPayload = {}) {
    return this._request('POST', `/v1/databases/${databaseId}/query`, queryPayload);
  }

  /**
   * 자식 블록 조회: GET /v1/blocks/{id}/children
   */
  async getBlockChildren(blockId) {
    return this._request('GET', `/v1/blocks/${blockId}/children`);
  }
}

module.exports = {
  NOTION_API_VERSION,
  NotionClient
};
