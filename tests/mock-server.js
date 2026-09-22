/**
 * E2E 테스트용 독립 Mock Notion HTTP 서버
 * 포트 0으로 바인딩하여 OS가 할당한 포트를 stdout 첫 줄에 출력
 */

const http = require('node:http');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsedBody = null;
    try { parsedBody = body ? JSON.parse(body) : null; } catch { parsedBody = null; }

    // POST /v1/pages
    if (req.url === '/v1/pages' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'mock-e2e-page-777', object: 'page' }));
    }

    // POST /v1/databases/.../query
    if (req.url.startsWith('/v1/databases/') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        results: [
          {
            id: 'mock-e2e-page-777',
            properties: {
              Title: { title: [{ plain_text: 'E2E Session Handover' }] },
              Project: { select: { name: 'aleph-05-memory' } },
              Phase: { select: { name: 'A_END' } },
              CommitHash: { rich_text: [{ plain_text: '1234567890abcdef1234567890abcdef12345678' }] }
            }
          }
        ]
      }));
    }

    // GET /v1/blocks/.../children
    if (req.url.startsWith('/v1/blocks/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        results: [
          { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ text: { content: '1. 목표' } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: '복원된 목표 본문입니다.' } }] } }
        ]
      }));
    }

    res.writeHead(404);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`READY:${port}`);
});
