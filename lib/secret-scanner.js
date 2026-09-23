/**
 * Gitleaks 공식 룰셋 기반 경량 시크릿 스캐너
 * Zero-dependency Node.js 구현 (Allowlist 기반 오탐 방지 포함)
 *
 * Portions of regex rules are derived from Gitleaks (https://github.com/gitleaks/gitleaks)
 * Copyright (c) 2019 Zachary Rice
 * Licensed under the MIT License.
 */

// Gitleaks v8 공식 룰셋 기반 정규식 정의
const GITLEAKS_RULES = [
  {
    id: 'notion-api-token',
    description: 'Notion Integration Secret or Token',
    regex: /\b(?:secret_|ntn_)[a-zA-Z0-9]{30,}\b/
  },
  {
    id: 'github-pat',
    description: 'GitHub Personal Access Token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub Fine-grained Personal Access Token',
    regex: /\bgithub_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}\b/
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API Key',
    regex: /\bsk-(?:proj-)?[a-zA-Z0-9_\-]{32,}\b/
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic Claude API Key',
    regex: /\bsk-ant-(?:api03|admin01)-[a-zA-Z0-9_\-]{90,}AA\b/
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS Access Key ID',
    regex: /\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b/
  },
  {
    id: 'gcp-api-key',
    description: 'Google Cloud Platform API Key',
    regex: /\bAIza[0-9A-Za-z\\-_]{35}\b/
  },
  {
    id: 'slack-token',
    description: 'Slack Bot or User Token',
    regex: /\bxox[baprs]-[0-9a-zA-Z\-]{10,}\b/
  },
  {
    id: 'private-key',
    description: 'Private Key Block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  },
  {
    id: 'generic-secret-assignment',
    description: 'Generic Secret Assignment in Code or Config',
    regex: /(?:api_?key|access_?token|secret_?key|auth_?token|client_?secret)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{20,})["']?/i
  }
];

// 오탐(False Positive) 방지를 위한 Gitleaks 스타일 Allowlist
const ALLOWLIST_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID (Notion DB ID)
  /^[0-9a-f]{40}$/i,                                                     // 40자리 Git Commit Hash
  /^(?:mock-key|dummy-token|test-key|secret_xxx|secret_\.{3,}|xxx|\*{3,})$/i // 테스트용 마스킹 플레이스홀더
];

/**
 * 텍스트가 Allowlist(안전 식별자)에 해당하는지 판별
 * @param {string} text 
 * @returns {boolean}
 */
function isAllowed(text) {
  const trimmed = text.trim();
  return ALLOWLIST_PATTERNS.some((pat) => pat.test(trimmed));
}

/**
 * 마크다운 또는 텍스트 본문에서 시크릿 누출 스캔
 * @param {string} text 
 * @returns {object[]} 탐지된 누출 목록 [{ ruleId, description, match, line }]
 */
function scanSecrets(text) {
  const leaks = [];
  const lines = text.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    for (const rule of GITLEAKS_RULES) {
      const match = line.match(rule.regex);
      if (match) {
        const secretVal = match[1] || match[0];

        // Allowlist 검증 (UUID, Commit Hash, Masked 값 통과)
        if (isAllowed(secretVal)) {
          continue;
        }

        leaks.push({
          ruleId: rule.id,
          description: rule.description,
          match: secretVal.slice(0, 10) + '...', // 보안을 위해 앞부분만 로깅
          line: lineIdx + 1
        });
      }
    }
  }

  return leaks;
}

module.exports = {
  GITLEAKS_RULES,
  ALLOWLIST_PATTERNS,
  isAllowed,
  scanSecrets
};
