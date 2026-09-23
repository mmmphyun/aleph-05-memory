/**
 * 7대 필수 섹션 의미론적 델타 연산기
 * 직전 세션 대비 변경된 섹션만 추출하여 LLM 프롬프트 토큰을 절감하고,
 * 파일 복원 시에는 항상 7섹션 완전체 무결성을 보장합니다.
 */

const crypto = require('node:crypto');

const MANDATORY_SECTIONS = [
  '목표',
  '현재 상태',
  '실행 명령',
  '통과 검사',
  '남은 문제',
  '다음 행동',
  '건드리지 말 것'
];

/**
 * 마크다운에서 H1 섹션별 본문 파싱
 */
function extractSections(markdown) {
  const lines = (markdown || '').split(/\r?\n/);
  const sections = {};
  let currentSection = null;
  let buffer = [];

  for (const line of lines) {
    const h1Match = line.match(/^#\s*(?:\d+\.\s*)?([^\n\r]+)/);
    if (h1Match) {
      if (currentSection) {
        sections[currentSection] = buffer.join('\n').trim();
      }
      const rawTitle = h1Match[1].trim();
      const matchedCanonical = MANDATORY_SECTIONS.find((sec) => rawTitle.includes(sec));
      currentSection = matchedCanonical || rawTitle;
      buffer = [];
    } else {
      if (currentSection) {
        buffer.push(line);
      }
    }
  }

  if (currentSection) {
    sections[currentSection] = buffer.join('\n').trim();
  }

  return sections;
}

/**
 * 텍스트 해시 계산
 */
function hashContent(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

/**
 * 직전 세션(Base)과 현재 세션(Target) 간 섹션별 델타 계산
 */
function computeMarkdownDelta(baseMarkdown, targetMarkdown) {
  const baseSections = extractSections(baseMarkdown);
  const targetSections = extractSections(targetMarkdown);

  const changedSections = [];
  const unchangedSections = [];
  const sectionDiffs = {};

  for (const section of MANDATORY_SECTIONS) {
    const baseText = baseSections[section] || '';
    const targetText = targetSections[section] || '';

    const baseHash = hashContent(baseText);
    const targetHash = hashContent(targetText);

    if (baseHash !== targetHash) {
      changedSections.push(section);
      sectionDiffs[section] = {
        isChanged: true,
        baseLength: baseText.length,
        targetLength: targetText.length,
        content: targetText
      };
    } else {
      unchangedSections.push(section);
      sectionDiffs[section] = {
        isChanged: false,
        content: targetText
      };
    }
  }

  return {
    changedSections,
    unchangedSections,
    sectionDiffs,
    hasChanges: changedSections.length > 0
  };
}

/**
 * 터미널 표준 출력 및 LLM 프롬프트 주입용 경량 델타 요약 마크다운 생성
 */
function formatDeltaSummary(deltaResult, baseCommit = 'previous', targetCommit = 'current') {
  if (!deltaResult.hasChanges) {
    return `[DELTA_SUMMARY] No changes detected between ${baseCommit.slice(0, 7)} and ${targetCommit.slice(0, 7)}.`;
  }

  const lines = [
    `# 세션 인수인계 델타 요약 (${baseCommit.slice(0, 7)} ➔ ${targetCommit.slice(0, 7)})`,
    ``,
    `* **변경된 섹션 (${deltaResult.changedSections.length}개)**: ${deltaResult.changedSections.join(', ')}`,
    `* **유지된 섹션 (${deltaResult.unchangedSections.length}개)**: ${deltaResult.unchangedSections.join(', ')}`,
    ``,
    `---`,
    ``
  ];

  let sectionIdx = 1;
  for (const section of MANDATORY_SECTIONS) {
    const diff = deltaResult.sectionDiffs[section];
    if (diff && diff.isChanged) {
      lines.push(`## ${sectionIdx}. ${section} [수정됨]`);
      lines.push(diff.content);
      lines.push(``);
    }
    sectionIdx++;
  }

  return lines.join('\n');
}

/**
 * 델타와 베이스라인을 결합하여 온전한 7섹션 마크다운 재구성 (파일 복원용)
 */
function reconstructFullMarkdown(baseMarkdown, deltaResult) {
  const baseSections = extractSections(baseMarkdown);
  const lines = [];

  let idx = 1;
  for (const section of MANDATORY_SECTIONS) {
    const diff = deltaResult.sectionDiffs[section];
    const content = diff ? diff.content : (baseSections[section] || '');
    lines.push(`# ${idx}. ${section}`);
    lines.push(content);
    lines.push(``);
    idx++;
  }

  return lines.join('\n').trim();
}

module.exports = {
  MANDATORY_SECTIONS,
  extractSections,
  computeMarkdownDelta,
  formatDeltaSummary,
  reconstructFullMarkdown
};
