/**
 * Notion API 클라이언트 및 Mock 서버 연동 단위 테스트
 */

const assert = require('node:assert');
const http = require('node:http');
const { NotionClient, NOTION_API_VERSION } = require('../lib/notion-client');

console.log('[TEST] Starting Notion Client Tests...');

const MOCK_PORT = 9876;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

// 1. 토큰 미설정 시 사전 차단 검증 (T05)
{
  const clientNoKey = new NotionClient({ apiKey: '' });
  assert.rejects(
    async () => {
      await clientNoKey.createPage('dummy-db', {});
    },
    (err) => {
      assert.strictEqual(err.code, 'ERR_AUTH_MISSING');
      assert.match(err.message, /\[AUTH_ERROR\] NOTION_API_KEY is not set in environment/);
      return true;
    },
    'API 키 누락 시 AUTH_ERROR가 발생해야 함'
  );
  console.log('  PASS: API 토큰 누락 시 사전 차단 검증 (T05)');
}

// Mock 서버를 통한 네트워크 규격 및 재시도 검증
async function runMockServerTests() {
  let requestCount = 0;
  let receivedHeaders = null;
  let receivedBody = null;

  const server = http.createServer((req, res) => {
    requestCount++;
    receivedHeaders = req.headers;

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        receivedBody = body ? JSON.parse(body) : null;
      } catch {
        receivedBody = body;
      }

      // 시나리오 1: 429 재시도 테스트 엔드포인트
      if (req.url === '/v1/pages' && req.method === 'POST') {
        if (requestCount === 1) {
          // 1회차: 429 Too Many Requests 반환
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '1'
          });
          return res.end(JSON.stringify({ message: 'Rate limit exceeded' }));
        } else {
          // 2회차: 정상 200 반환
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'mock-page-id-1234', object: 'page' }));
        }
      }

      // 시나리오 2: 일반 데이터베이스 쿼리
      if (req.url.startsWith('/v1/databases/') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          object: 'list',
          results: [
            { id: 'page-1', properties: { Title: { title: [{ plain_text: 'Session 1' }] } } }
          ]
        }));
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(MOCK_PORT, resolve));

  try {
    const client = new NotionClient({
      apiKey: 'test-secret-token-xyz',
      baseUrl: MOCK_BASE_URL,
      maxRetries: 2
    });

    // 2. HTTP 429 지수 백오프 및 헤더 규격 검증 (T07, T08)
    {
      requestCount = 0;
      const result = await client.createPage('mock-db-id', {
        Name: { title: [{ text: { content: 'Test Page' } }] }
      });

      assert.strictEqual(result.statusCode, 200);
      assert.strictEqual(result.data.id, 'mock-page-id-1234');
      assert.strictEqual(requestCount, 2, '429 발생 후 총 2회 요청이 발생해야 함');

      // 헤더 검증 (T07)
      assert.strictEqual(receivedHeaders['authorization'], 'Bearer test-secret-token-xyz');
      assert.strictEqual(receivedHeaders['notion-version'], NOTION_API_VERSION);
      assert.strictEqual(receivedHeaders['content-type'], 'application/json');
      console.log('  PASS: Notion HTTP 헤더 규격 및 429 지수 백오프 재시도 성공 검증 (T07, T08)');
    }

    // 3. 데이터베이스 쿼리 검증
    {
      const queryRes = await client.queryDatabase('mock-db-id', {});
      assert.strictEqual(queryRes.statusCode, 200);
      assert.strictEqual(queryRes.data.results.length, 1);
      console.log('  PASS: Mock Database Query 응답 처리 검증');
    }

  } finally {
    server.close();
  }
}

runMockServerTests()
  .then(() => {
    console.log('[TEST] All Notion Client Tests Passed Successfully.');
  })
  .catch((err) => {
    console.error(`[TEST_FAIL] ${err.message}`);
    process.exit(1);
  });
