/**
 * 마크다운 <-> Notion Block 변환 및 2000자 청크 분할 단위 테스트
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_NOTION_TEXT_LENGTH,
  chunkText,
  markdownToNotionBlocks,
  notionBlocksToMarkdown
} = require('../lib/block-transformer');

console.log('[TEST] Starting Block Transformer Tests...');

// 1. 순수 텍스트 청킹 단위 테스트
{
  const longText = 'A'.repeat(5500);
  const chunks = chunkText(longText, 2000);
  assert.strictEqual(chunks.length, 3, '5500자는 3개의 청크(2000, 2000, 1500)로 분할되어야 함');
  chunks.forEach((chunk, idx) => {
    assert.ok(chunk.length <= 2000, `청크 ${idx}는 2000자 이하여야 함 (실제: ${chunk.length})`);
  });
  console.log('  PASS: 순수 텍스트 2000자 청킹 검증');
}

// 2. overflow.md 마크다운 변환 및 T04 검사 검증
{
  const overflowMd = fs.readFileSync(path.join(__dirname, 'fixtures/overflow.md'), 'utf8');
  const blocks = markdownToNotionBlocks(overflowMd);

  assert.ok(blocks.length > 5, '충분한 수의 블록 객체가 생성되어야 함');

  for (const block of blocks) {
    assert.strictEqual(block.object, 'block', '모든 블록은 object: block 이어야 함');
    const type = block.type;
    const blockContent = block[type];
    assert.ok(blockContent, `블록 타입 ${type}의 내용이 존재해야 함`);

    if (blockContent.rich_text) {
      for (const rt of blockContent.rich_text) {
        const len = rt.text.content.length;
        assert.ok(
          len <= MAX_NOTION_TEXT_LENGTH,
          `블록 ${type}의 rich_text 길이가 2000자를 초과함: ${len}자`
        );
      }
    }
  }
  console.log('  PASS: 3000자 초과 마크다운의 2000자 이하 블록 자동 분할 (T04)');
}

// 3. 마크다운 -> Notion Block -> 마크다운 양방향 역직렬화 검증
{
  const sampleMd = `# 헤딩 1\n## 헤딩 2\n- 불릿 항목 1\n- 불릿 항목 2\n\`\`\`javascript\nconsole.log("hello");\n\`\`\`\n일반 단락 본문입니다.`;
  const blocks = markdownToNotionBlocks(sampleMd);
  const restoredMd = notionBlocksToMarkdown(blocks);

  assert.ok(restoredMd.includes('# 헤딩 1'), '헤딩 1 복원 확인');
  assert.ok(restoredMd.includes('## 헤딩 2'), '헤딩 2 복원 확인');
  assert.ok(restoredMd.includes('불릿 항목 1'), '불릿 항목 복원 확인');
  assert.ok(restoredMd.includes('console.log("hello");'), '코드 블록 복원 확인');
  assert.ok(restoredMd.includes('일반 단락 본문입니다.'), '일반 단락 복원 확인');
  console.log('  PASS: Notion Block to Markdown 양방향 역직렬화 무결성 검증');
}

console.log('[TEST] All Block Transformer Tests Passed Successfully.');
