/**
 * 마크다운 <-> Notion Block 객체 양방향 변환기
 * 2,000자 청크 분할 및 Notion API 블록 스키마 준수
 */

const MAX_NOTION_TEXT_LENGTH = 2000;

/**
 * 긴 텍스트를 2,000자 이하의 조각들로 안전 분할
 * @param {string} text 
 * @param {number} maxLength 
 * @returns {string[]}
 */
function chunkText(text, maxLength = MAX_NOTION_TEXT_LENGTH) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 2000자 이내에서 가장 가까운 개행이나 문장 구분자 찾기
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf('. ', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx === -1 || splitIdx === 0) {
      splitIdx = maxLength;
    } else {
      splitIdx += 1; // 구분자 포함
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return chunks;
}

/**
 * 텍스트 문자열을 Notion rich_text 배열로 변환 (청크 처리 포함)
 * @param {string} text 
 * @returns {object[]}
 */
function createRichText(text) {
  const chunks = chunkText(text, MAX_NOTION_TEXT_LENGTH);
  return chunks.map((chunk) => ({
    type: 'text',
    text: {
      content: chunk,
      link: null
    }
  }));
}

/**
 * 마크다운 본문을 Notion Block Child 객체 배열로 변환
 * @param {string} markdownText 
 * @returns {object[]} Notion block objects
 */
function markdownToNotionBlocks(markdownText) {
  const lines = markdownText.split(/\r?\n/);
  const blocks = [];
  let inCodeBlock = false;
  let codeLang = 'plain text';
  let codeBuffer = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 코드 블록 처리
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // 코드 블록 닫기
        const fullCode = codeBuffer.join('\n');
        const codeChunks = chunkText(fullCode, MAX_NOTION_TEXT_LENGTH);
        for (const chunk of codeChunks) {
          blocks.push({
            object: 'block',
            type: 'code',
            code: {
              language: codeLang || 'plain text',
              rich_text: [{ type: 'text', text: { content: chunk } }]
            }
          });
        }
        inCodeBlock = false;
        codeBuffer = [];
        codeLang = 'plain text';
      } else {
        // 코드 블록 열기
        inCodeBlock = true;
        const match = line.trim().match(/^```([a-zA-Z0-9_\-\+]*)/);
        codeLang = match && match[1] ? match[1].toLowerCase() : 'plain text';
        // Notion 허용 언어 정규화
        if (codeLang === 'sh' || codeLang === 'pwsh') codeLang = 'bash';
        if (codeLang === 'js') codeLang = 'javascript';
        if (codeLang === 'ts') codeLang = 'typescript';
        if (codeLang === 'py') codeLang = 'python';
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue; // 빈 줄 스킵

    // 헤딩 1
    if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: createRichText(line.slice(2).trim())
        }
      });
      continue;
    }

    // 헤딩 2
    if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: createRichText(line.slice(3).trim())
        }
      });
      continue;
    }

    // 헤딩 3
    if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: createRichText(line.slice(4).trim())
        }
      });
      continue;
    }

    // 불릿 리스트
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: createRichText(trimmed.slice(2).trim())
        }
      });
      continue;
    }

    // 번호 리스트
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: createRichText(numMatch[2].trim())
        }
      });
      continue;
    }

    // 일반 문단 (긴 문단은 청크별로 별도 블록 분할)
    const pChunks = chunkText(trimmed, MAX_NOTION_TEXT_LENGTH);
    for (const pChunk of pChunks) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: pChunk } }]
        }
      });
    }
  }

  return blocks;
}

/**
 * Notion Block 배열을 다시 마크다운 문자열로 역변환
 * @param {object[]} blocks 
 * @returns {string} Markdown text
 */
function notionBlocksToMarkdown(blocks) {
  if (!Array.isArray(blocks)) return '';

  const mdParts = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];
    if (!content) continue;

    const text = (content.rich_text || [])
      .map((r) => r.plain_text || (r.text && r.text.content) || '')
      .join('');

    switch (type) {
      case 'heading_1':
        mdParts.push(`# ${text}\n`);
        break;
      case 'heading_2':
        mdParts.push(`## ${text}\n`);
        break;
      case 'heading_3':
        mdParts.push(`### ${text}\n`);
        break;
      case 'bulleted_list_item':
        mdParts.push(`- ${text}`);
        break;
      case 'numbered_list_item':
        mdParts.push(`1. ${text}`);
        break;
      case 'code':
        mdParts.push(`\`\`\`${content.language || ''}\n${text}\n\`\`\``);
        break;
      case 'paragraph':
        mdParts.push(`${text}\n`);
        break;
      default:
        if (text) mdParts.push(`${text}\n`);
        break;
    }
  }

  return mdParts.join('\n').trim();
}

module.exports = {
  MAX_NOTION_TEXT_LENGTH,
  chunkText,
  createRichText,
  markdownToNotionBlocks,
  notionBlocksToMarkdown
};
