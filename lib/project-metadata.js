/**
 * 경량 프로젝트 메타데이터 수집 및 로컬 캐싱 모듈
 * 토큰 낭비를 방지하기 위해 파일 전체를 읽지 않고 설정 파일 존재 여부 및 README 첫 30줄만 슬라이싱합니다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const CACHE_FILE_NAME = '.session-sync.json';

/**
 * Git 환경 기반 기본 메타데이터 추출
 */
function getGitRemoteInfo() {
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    let repoUrl = '';
    try {
      repoUrl = execSync('git config --get remote.origin.url', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch {
      repoUrl = '';
    }
    const projectName = path.basename(repoRoot);
    return { repoRoot, repoUrl, projectName };
  } catch {
    const cwd = process.cwd();
    return { repoRoot: cwd, repoUrl: '', projectName: path.basename(cwd) };
  }
}

/**
 * 설정 파일 시그니처 기반 기술 스택 감지
 */
function detectTechStack(rootDir) {
  const stacks = [];
  const checks = [
    { file: 'package.json', stack: 'Node.js' },
    { file: 'pyproject.toml', stack: 'Python' },
    { file: 'requirements.txt', stack: 'Python' },
    { file: 'Cargo.toml', stack: 'Rust' },
    { file: 'go.mod', stack: 'Go' },
    { file: 'pom.xml', stack: 'Java' },
    { file: 'build.gradle', stack: 'Gradle' },
    { file: 'build.gradle.kts', stack: 'Kotlin' },
    { file: 'Dockerfile', stack: 'Docker' }
  ];

  for (const { file, stack } of checks) {
    if (fs.existsSync(path.join(rootDir, file))) {
      if (!stacks.includes(stack)) {
        stacks.push(stack);
      }
    }
  }

  // TypeScript 감지 (tsconfig.json 또는 package.json 의존성)
  if (fs.existsSync(path.join(rootDir, 'tsconfig.json'))) {
    stacks.push('TypeScript');
  }

  return stacks.length > 0 ? stacks : ['General'];
}

/**
 * README.md 최상단 30줄에서 첫 설명 문단 추출 (최대 200자)
 */
function extractReadmeSummary(rootDir) {
  const candidates = ['README.md', 'readme.md', 'README'];
  for (const name of candidates) {
    const fullPath = path.join(rootDir, name);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split(/\r?\n/).slice(0, 30);
        let foundTitle = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('#')) {
            foundTitle = true;
            continue;
          }
          if (foundTitle && !trimmed.startsWith('#') && !trimmed.startsWith('![')) {
            return trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
          }
        }
      } catch {
        break;
      }
    }
  }
  return 'No project description provided.';
}

/**
 * 프로젝트 메타데이터 취합
 */
function collectProjectMetadata(customRootDir) {
  const { repoRoot, repoUrl, projectName } = getGitRemoteInfo();
  const rootDir = customRootDir || repoRoot;
  const techStack = detectTechStack(rootDir);
  const description = extractReadmeSummary(rootDir);

  return {
    projectName,
    repoUrl,
    techStack,
    description,
    rootDir
  };
}

/**
 * 로컬 캐시(.session-sync.json) 조회
 */
function loadProjectCache(rootDir) {
  const targetDir = rootDir || process.cwd();
  const cachePath = path.join(targetDir, CACHE_FILE_NAME);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 로컬 캐시(.session-sync.json) 저장
 */
function saveProjectCache(rootDir, data) {
  const targetDir = rootDir || process.cwd();
  const cachePath = path.join(targetDir, CACHE_FILE_NAME);
  const existing = loadProjectCache(targetDir) || {};
  const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
  fs.writeFileSync(cachePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  CACHE_FILE_NAME,
  getGitRemoteInfo,
  detectTechStack,
  extractReadmeSummary,
  collectProjectMetadata,
  loadProjectCache,
  saveProjectCache
};
