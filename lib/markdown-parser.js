/**
 * 7칸 인수인계 마크다운 파서 및 가드레일 유효성 검증기
 */

const fs = require('node:fs');
const path = require('node:path');

// 7대 필수 인수인계 규격 정의 (유사 표기 포함)
const REQUIRED_SECTIONS = [
  { id: 'goal', title: '목표', pattern: /(?:#+\s*(?:1[\.\s]*)?목표)/i },
  { id: 'status', title: '현재 상태', pattern: /(?:#+\s*(?:2[\.\s]*)?현재\s*상태)/i },
  { id: 'command', title: '실행 명령', pattern: /(?:#+\s*(?:3[\.\s]*)?실행\s*명령)/i },
  { id: 'passed', title: '통과 검사', pattern: /(?:#+\s*(?:4[\.\s]*)?통과\s*검사)/i },
  { id: 'issues', title: '남은 문제', pattern: /(?:#+\s*(?:5[\.\s]*)?남은\s*문제)/i },
  { id: 'next', title: '다음 행동', pattern: /(?:#+\s*(?:6[\.\s]*)?다음\s*행동)/i },
  { id: 'prohibited', title: '건드리지 말 것', pattern: /(?:#+\s*(?:7[\.\s]*)?건드리지\s*말\s*것|금지\s*범위)/i }
];

// 에이전트의 불성실 기재/우회 시도 차단용 정규식
const BYPASS_PATTERNS = [
  /^(?:todo|tbd|n\/a|none|없음|추후\s*작성|기존과\s*동일|생략|[-_.\s]+)$/i
];

const MIN_CONTENT_LENGTH = 15; // 공백 제외 최소 15자 이상 실질적 내용 요구

/**
 * 마크다운 텍스트를 파싱하여 7개 섹션으로 분해 및 무결성 검증
 * @param {string} markdownContent 
 * @param {object} options 
 * @returns {object} { isValid: boolean, sections: object, errors: string[] }
 */
function parseHandoverMarkdown(markdownContent, options = {}) {
  const lines = markdownContent.split(/\r?\n/);
  const sections = {};
  const errors = [];

  // 1. 헤딩 위치 및 라인 인덱스 탐색
  const matchedPositions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#')) continue;

    for (const req of REQUIRED_SECTIONS) {
      if (req.pattern.test(line)) {
        matchedPositions.push({
          id: req.id,
          title: req.title,
          lineIndex: i,
          rawHeader: line
        });
        break;
      }
    }
  }

  // 2. 7개 필수 섹션 존재 유무 검증
  for (const req of REQUIRED_SECTIONS) {
    const found = matchedPositions.find((m) => m.id === req.id);
    if (!found) {
      errors.push(`[VALIDATION_ERROR] Missing required section: '${req.title}'`);
    }
  }

  if (errors.length > 0) {
    return { isValid: false, sections: null, errors };
  }

  // 3. 각 섹션 본문 슬라이싱 및 본문 유효성(Guard 1) 검증
  for (let idx = 0; idx < matchedPositions.length; idx++) {
    const current = matchedPositions[idx];
    const next = matchedPositions[idx + 1];

    const startLine = current.lineIndex + 1;
    const endLine = next ? next.lineIndex : lines.length;

    const contentLines = lines.slice(startLine, endLine);
    const contentRaw = contentLines.join('\n').trim();
    const cleanChars = contentRaw.replace(/[\s\-_*#`]/g, '');

    // 3-1. 공백 제외 최소 길이 검증
    if (cleanChars.length < MIN_CONTENT_LENGTH) {
      errors.push(
        `[GUARD_ERROR] Section '${current.title}' contains insufficient detail (${cleanChars.length} chars, min ${MIN_CONTENT_LENGTH} required).`
      );
    }

    // 3-2. 회피성 불성실 키워드 단독 기재 차단
    for (const bp of BYPASS_PATTERNS) {
      if (bp.test(contentRaw)) {
        errors.push(
          `[GUARD_ERROR] Section '${current.title}' contains prohibited evasion placeholder: '${contentRaw}'. Detailed factual description required.`
        );
        break;
      }
    }

    sections[current.id] = {
      id: current.id,
      title: current.title,
      content: contentRaw
    };
  }

  // 4. 실행 명령 섹션의 정적 검증 (Guard 3)
  if (sections.command) {
    const commandContent = sections.command.content;
    const codeBlockMatch = commandContent.match(/```(?:bash|sh|powershell|pwsh|cmd)?\r?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      sections.command.parsedCommands = codeBlockMatch[1]
        .split(/\r?\n/)
        .map((cmd) => cmd.trim())
        .filter((cmd) => cmd.length > 0 && !cmd.startsWith('#'));
    } else {
      // 코드 블록이 없는 경우 경고 또는 단일 라인 파싱
      sections.command.parsedCommands = commandContent
        .split(/\r?\n/)
        .map((cmd) => cmd.trim())
        .filter((cmd) => cmd.length > 0);
    }
  }

  return {
    isValid: errors.length === 0,
    sections: errors.length === 0 ? sections : null,
    errors
  };
}

module.exports = {
  REQUIRED_SECTIONS,
  parseHandoverMarkdown
};
