/**
 * session-sync 환경 무결성 전수 진단 모듈 (doctor)
 * Non-blocking All-in-one check pipeline
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { execSync } = require('node:child_process');

/**
 * .env 파일 파싱 헬퍼
 * @param {string} cwd 
 * @returns {object}
 */
function parseEnvFile(cwd = process.cwd()) {
  const envPath = path.resolve(cwd, '.env');
  const envMap = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        envMap[k] = v;
      }
    }
  }
  return { exists: fs.existsSync(envPath), envMap };
}

/**
 * UUID / Hex32 규격 검증
 * @param {string} str 
 * @returns {boolean}
 */
function isValidNotionId(str) {
  if (!str || typeof str !== 'string') return false;
  const cleaned = str.replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(cleaned);
}

/**
 * Notion API Users/Me Ping 요청
 * @param {string} apiKey 
 * @param {object} options 
 * @returns {Promise<object>}
 */
function pingNotionApi(apiKey, options = {}) {
  return new Promise((resolve) => {
    if (!apiKey) {
      return resolve({
        status: 'FAIL',
        code: 0,
        message: 'NOTION_API_KEY is missing. Cannot ping Notion API.'
      });
    }

    if (options.mockPing) {
      return resolve(options.mockPing(apiKey));
    }

    const targetUrl = options.pingUrl || 'https://api.notion.com/v1/users/me';
    const isHttps = targetUrl.startsWith('https:');
    const client = isHttps ? https : http;

    try {
      const urlObj = new URL(targetUrl);
      const req = client.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Notion-Version': '2022-06-28',
            'User-Agent': 'session-sync-doctor/1.0.0'
          },
          timeout: options.timeout || 3500
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              let botName = 'Notion Bot';
              try {
                const parsed = JSON.parse(body);
                if (parsed.name) botName = parsed.name;
                else if (parsed.bot && parsed.bot.owner) botName = 'Bot Integrated';
              } catch (_) {}
              resolve({
                status: 'PASS',
                code: 200,
                message: `HTTP 200 OK (Authenticated as: ${botName})`
              });
            } else if (res.statusCode === 401) {
              resolve({
                status: 'FAIL',
                code: 401,
                message: 'HTTP 401 Unauthorized (Invalid or expired NOTION_API_KEY)'
              });
            } else if (res.statusCode === 403) {
              resolve({
                status: 'FAIL',
                code: 403,
                message: 'HTTP 403 Forbidden (Bot lacks permission)'
              });
            } else {
              resolve({
                status: 'WARN',
                code: res.statusCode,
                message: `HTTP ${res.statusCode} response from Notion API`
              });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({
          status: 'FAIL',
          code: 0,
          message: `Network connection failed: ${err.message}`
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          status: 'FAIL',
          code: 0,
          message: 'Connection timed out (3500ms limit exceeded)'
        });
      });

      req.end();
    } catch (err) {
      resolve({
        status: 'FAIL',
        code: 0,
        message: `Request setup failed: ${err.message}`
      });
    }
  });
}

/**
 * 5대 전수 환경 무결성 진단 실행
 * @param {object} options 
 * @returns {Promise<object>}
 */
async function runDoctor(options = {}) {
  const cwd = options.cwd || process.cwd();
  const checks = [];

  // 1. Node.js 런타임 버전 검증
  const nodeVer = options.nodeVersion || process.version;
  const majorVer = parseInt(nodeVer.replace(/^v/, '').split('.')[0], 10);
  if (majorVer >= 20) {
    checks.push({
      id: 'NODE_VERSION',
      title: 'Node.js Runtime',
      status: 'PASS',
      message: `${nodeVer} (Baseline: >= v20.0.0)`
    });
  } else {
    checks.push({
      id: 'NODE_VERSION',
      title: 'Node.js Runtime',
      status: 'FAIL',
      message: `${nodeVer} is outdated. Node.js v20.0.0 or higher is required.`
    });
  }

  // 2. Git VCS 가용성 검증
  let gitPassed = false;
  try {
    const gitOut = (options.execSync || execSync)('git --version', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    checks.push({
      id: 'GIT_VCS',
      title: 'Git VCS',
      status: 'PASS',
      message: gitOut
    });
    gitPassed = true;
  } catch (err) {
    checks.push({
      id: 'GIT_VCS',
      title: 'Git VCS',
      status: 'FAIL',
      message: 'git command not found or execution failed. Install Git and register to PATH.'
    });
  }

  // 3. CLI Binary / PATH 접근성 검증
  let cliFound = false;
  let cliPath = '';
  try {
    const isWin = process.platform === 'win32';
    const whereCmd = isWin ? 'where.exe session-sync' : 'which session-sync';
    const whereOut = (options.execSync || execSync)(whereCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (whereOut) {
      cliFound = true;
      cliPath = whereOut.split(/\r?\n/)[0];
    }
  } catch (_) {}

  if (cliFound) {
    checks.push({
      id: 'CLI_BINARY',
      title: 'CLI Binary (PATH)',
      status: 'PASS',
      message: `Global command reachable at ${cliPath}`
    });
  } else {
    checks.push({
      id: 'CLI_BINARY',
      title: 'CLI Binary (PATH)',
      status: 'WARN',
      message: "'session-sync' is not in system PATH. Run 'npm link' to enable global invocation."
    });
  }

  // 4. .env 파일 및 3대 환경변수 무결성 검증
  const envInfo = options.envOverride ? { exists: true, envMap: options.envOverride } : parseEnvFile(cwd);
  const effectiveEnv = { ...envInfo.envMap, ...process.env, ...(options.envOverride || {}) };

  // 4-1. .env 파일 존재
  if (envInfo.exists) {
    checks.push({
      id: 'ENV_FILE',
      title: '.env Configuration',
      status: 'PASS',
      message: 'Local .env file found'
    });
  } else {
    checks.push({
      id: 'ENV_FILE',
      title: '.env Configuration',
      status: 'WARN',
      message: '.env file not found in current directory'
    });
  }

  // 4-2. NOTION_API_KEY
  const apiKey = effectiveEnv.NOTION_API_KEY;
  if (!apiKey) {
    checks.push({
      id: 'NOTION_API_KEY',
      title: 'NOTION_API_KEY',
      status: 'FAIL',
      message: 'Missing NOTION_API_KEY in environment or .env'
    });
  } else if (!apiKey.startsWith('secret_') && !apiKey.startsWith('ntn_')) {
    checks.push({
      id: 'NOTION_API_KEY',
      title: 'NOTION_API_KEY',
      status: 'FAIL',
      message: "Invalid token format. Must begin with 'secret_' or 'ntn_'"
    });
  } else if (apiKey.length < 20) {
    checks.push({
      id: 'NOTION_API_KEY',
      title: 'NOTION_API_KEY',
      status: 'FAIL',
      message: 'Token length is suspiciously short (< 20 chars)'
    });
  } else {
    const masked = apiKey.slice(0, 7) + '...' + apiKey.slice(-4);
    checks.push({
      id: 'NOTION_API_KEY',
      title: 'NOTION_API_KEY',
      status: 'PASS',
      message: `Valid token format (${masked})`
    });
  }

  // 4-3. NOTION_DATABASE_ID
  const dbId = effectiveEnv.NOTION_DATABASE_ID;
  if (!dbId) {
    checks.push({
      id: 'NOTION_DATABASE_ID',
      title: 'NOTION_DATABASE_ID',
      status: 'FAIL',
      message: 'Missing NOTION_DATABASE_ID in environment or .env'
    });
  } else if (!isValidNotionId(dbId)) {
    checks.push({
      id: 'NOTION_DATABASE_ID',
      title: 'NOTION_DATABASE_ID',
      status: 'FAIL',
      message: `Invalid ID format '${dbId}'. Must be 32-hex or 36-char RFC 4122 UUID.`
    });
  } else {
    checks.push({
      id: 'NOTION_DATABASE_ID',
      title: 'NOTION_DATABASE_ID',
      status: 'PASS',
      message: `Valid Database UUID (${dbId})`
    });
  }

  // 4-4. NOTION_PROJECTS_DATABASE_ID
  const projDbId = effectiveEnv.NOTION_PROJECTS_DATABASE_ID;
  if (!projDbId) {
    checks.push({
      id: 'NOTION_PROJECTS_DB',
      title: 'NOTION_PROJECTS_DB',
      status: 'WARN',
      message: 'Missing NOTION_PROJECTS_DATABASE_ID (Optional 2-Tier Projects relation)'
    });
  } else if (!isValidNotionId(projDbId)) {
    checks.push({
      id: 'NOTION_PROJECTS_DB',
      title: 'NOTION_PROJECTS_DB',
      status: 'FAIL',
      message: `Invalid Projects DB ID format '${projDbId}'.`
    });
  } else {
    checks.push({
      id: 'NOTION_PROJECTS_DB',
      title: 'NOTION_PROJECTS_DB',
      status: 'PASS',
      message: `Valid Projects Database UUID (${projDbId})`
    });
  }

  // 5. Notion API 통신 Ping
  const pingResult = await pingNotionApi(apiKey, options);
  checks.push({
    id: 'NOTION_API_PING',
    title: 'Notion API Ping',
    status: pingResult.status,
    message: pingResult.message
  });

  // 종합 집계
  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const warnCount = checks.filter((c) => c.status === 'WARN').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const hasBlockingFailure = failCount > 0;

  return {
    success: !hasBlockingFailure,
    checks,
    summary: {
      total: checks.length,
      pass: passCount,
      warn: warnCount,
      fail: failCount,
      hasBlockingFailure
    }
  };
}

/**
 * 진단 리포트 콘솔 포맷팅 및 출력
 * @param {object} doctorResult 
 */
function renderDoctorReport(doctorResult) {
  const { checks, summary } = doctorResult;

  console.log('================================================================================');
  console.log('  SESSION-SYNC ENVIRONMENT INTEGRITY DIAGNOSTIC REPORT');
  console.log('================================================================================');

  for (const check of checks) {
    const tag = `[${check.status}]`.padEnd(8);
    const title = check.title.padEnd(22);
    console.log(`${tag} ${title} : ${check.message}`);
  }

  console.log('================================================================================');
  const resultText = summary.hasBlockingFailure
    ? `DIAGNOSIS FAILED: ${summary.pass} passed, ${summary.warn} warning(s), ${summary.fail} blocking failure(s).`
    : `DIAGNOSIS PASSED: ${summary.pass} passed, ${summary.warn} warning(s), ${summary.fail} failure(s). Environment is operational.`;
  console.log(resultText);

  if (summary.fail > 0) {
    console.log('\n[ACTION REQUIRED]');
    const fails = checks.filter((c) => c.status === 'FAIL');
    for (const f of fails) {
      console.log(`  - ${f.title}: ${f.message}`);
    }
  }
  console.log('================================================================================');
}

/**
 * doctor 서브커맨드 실행 엔트리포인트
 * @param {object} options 
 */
async function executeDoctor(options = {}) {
  const result = await runDoctor(options);
  if (!options.silent) {
    renderDoctorReport(result);
  }
  return result;
}

module.exports = {
  isValidNotionId,
  parseEnvFile,
  pingNotionApi,
  runDoctor,
  renderDoctorReport,
  executeDoctor
};
