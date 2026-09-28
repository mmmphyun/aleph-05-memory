#!/usr/bin/env node

/**
 * session-sync CLI 엔트리포인트
 * Zero-dependency Node.js CLI for Agent Session Memory & Notion Sync
 */

const path = require('node:path');
const fs = require('node:fs');
const { executePush, executeFetch, getDatabaseSchema } = require('../lib/sync-engine');
const { NotionClient } = require('../lib/notion-client');
const { installHook, executeHook } = require('../lib/git-hook');
const { runCiPipeline } = require('../lib/ci-runner');
const { exportSessionMarkdown, listExportedArchives, ensureGitignoreEntry } = require('../lib/exporter');
const { saveProjectCache } = require('../lib/project-metadata');
const { executeScaffold } = require('../lib/scaffold');
const { executeDoctor } = require('../lib/doctor');
const { executeSearch } = require('../lib/search-engine');
const { executeVerify } = require('../lib/verifier');

function printUsage() {
  const usage = `
Usage: session-sync <command> [options]

Commands:
  init      빈 Notion 페이지 하위에 2-Tier Projects/Session DB 스키마 구축
  push      현재 세션 작업물(HANDOVER.md)을 Notion DB 및 로컬 큐에 적재
  fetch     Notion DB에서 세션 인덱스 또는 인수인계 본문 인출 (--diff 지원)
  scaffold  작업 트리 상태 기반 7섹션 인수인계서 초안 자동 생성
  doctor    환경 무결성 및 Notion 연결 상태 전수 진단
  search    과거 세션 아카이브 대상 하이브리드 RRF 융합 검색 (--mode hybrid|bm25|vector)
  verify    인수인계서와 실제 Git/작업트리/테스트 상태 불변식 검증
  hook      Git pre-push 훅 설치(install) 또는 실행(exec)
  ci        테스트 자동 실행, pass/fail 집계 및 Notion 푸시
  export    로컬 .session-memory/archives/ 에 마크다운 영구 보관

Options:
  -h, --help     도움말 출력
  -v, --version  버전 정보 출력

Run 'session-sync <command> --help' for command-specific options.
`.trim();
  console.log(usage);
}

function parseArgs(rawArgs) {
  const args = {
    command: null,
    subcommand: null,
    options: {},
    positionals: []
  };

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === '-h' || arg === '--help') {
      args.options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      args.options.version = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        args.options[key] = rawArgs[i + 1];
        i++;
      } else {
        args.options[key] = true;
      }
    } else if (!args.command) {
      args.command = arg;
    } else if (!args.subcommand) {
      args.subcommand = arg;
    } else {
      args.positionals.push(arg);
    }
    i++;
  }

  return args;
}

// .env 파일이 존재하는 경우 환경변수 로드
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
    }
  }
}

function extractPageId(raw) {
  if (!raw) return raw;
  const cleaned = raw.split('?')[0].split('#')[0];
  const match = cleaned.match(/([a-f0-9]{32})/i) || cleaned.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return match ? match[1].replace(/-/g, '') : raw;
}

function updateEnvFile(key, value) {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  let content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

async function main() {
  loadEnv();
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs(rawArgs);

  if (parsed.options.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    console.log(`session-sync v${pkg.version}`);
    process.exit(0);
  }

  if (parsed.options.help && !parsed.command) {
    printUsage();
    process.exit(0);
  }

  if (!parsed.command) {
    console.error("Usage: session-sync <init|push|fetch> [options]");
    console.error("Error: Subcommand missing. Run 'session-sync --help' for details.");
    process.exit(1);
  }

  const validCommands = ['init', 'push', 'fetch', 'scaffold', 'doctor', 'search', 'verify', 'hook', 'ci', 'export'];
  if (!validCommands.includes(parsed.command)) {
    console.error(`Error: Unknown command '${parsed.command}'.`);
    console.error(`Available commands: ${validCommands.join(', ')}`);
    process.exit(1);
  }

  switch (parsed.command) {
    case 'search': {
      if (parsed.options.help) {
        console.log("Usage: session-sync search --query <TEXT> [--mode <hybrid|bm25|vector>] [--section <NAME>] [--limit <NUM>] [--json]");
        process.exit(0);
      }
      const query = parsed.options.query;
      if (!query || typeof query !== 'string' || query.trim() === '') {
        console.error("Error: Missing --query <TEXT>");
        process.exit(1);
      }
      const { HybridSearchEngine, formatHybridResults } = require('../lib/hybrid-search');
      const engine = new HybridSearchEngine();
      await engine.initialize();
      const results = await engine.search(query, {
        mode: parsed.options.mode || 'hybrid',
        limit: parsed.options.limit ? Number(parsed.options.limit) : 3,
        section: parsed.options.section
      });
      if (parsed.options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(formatHybridResults(results, query, parsed.options.mode || 'hybrid'));
      }
      break;
    }

    case 'verify': {
      if (parsed.options.help) {
        console.log("Usage: session-sync verify [--file <PATH>] [--run-test] [--strict] [--timeout <MS>] [--json] [--silent]");
        process.exit(0);
      }
      executeVerify({
        file: parsed.options.file,
        runTest: Boolean(parsed.options['run-test']),
        strict: Boolean(parsed.options.strict),
        timeout: parsed.options.timeout ? Number(parsed.options.timeout) : undefined,
        json: Boolean(parsed.options.json),
        silent: Boolean(parsed.options.silent)
      });
      break;
    }

    case 'scaffold': {
      if (parsed.options.help) {
        console.log("Usage: session-sync scaffold [--out <PATH>] [--force] [--stdout]");
        process.exit(0);
      }
      executeScaffold({
        out: parsed.options.out,
        force: Boolean(parsed.options.force),
        stdout: Boolean(parsed.options.stdout)
      });
      break;
    }

    case 'doctor': {
      if (parsed.options.help) {
        console.log("Usage: session-sync doctor [--silent] [--timeout <MS>]");
        process.exit(0);
      }
      const docResult = await executeDoctor({
        silent: Boolean(parsed.options.silent),
        timeout: parsed.options.timeout ? Number(parsed.options.timeout) : undefined
      });
      if (docResult.summary && docResult.summary.hasBlockingFailure) {
        process.exit(1);
      }
      break;
    }

    case 'init': {
      if (parsed.options.help) {
        console.log("Usage: session-sync init --parent <PAGE_URL_OR_ID> [--write-env]");
        process.exit(0);
      }
      const rawParent = parsed.options.parent || process.env.NOTION_PARENT_PAGE_ID;
      if (!rawParent) {
        console.error("Error: Missing --parent <PAGE_ID_OR_URL>");
        process.exit(1);
      }
      const parentId = extractPageId(rawParent);
      const client = new NotionClient();

      console.log(`[INIT] Creating 2-Tier Notion Databases under parent page: ${parentId}...`);

      // 1. Projects DB 생성
      const projDbRes = await client.createProjectsDatabase(parentId);
      const projectsDbId = projDbRes.data.id;
      console.log(`[INIT_SUCCESS] Created Projects DB ID: ${projectsDbId}`);

      // 2. Session Memory DB 생성 (Projects DB와의 Relation 연결)
      const sessionSchema = getDatabaseSchema('Agent Session Memory DB', projectsDbId);
      const sessionDbRes = await client.createDatabase(parentId, sessionSchema);
      const sessionDbId = sessionDbRes.data.id;
      console.log(`[INIT_SUCCESS] Created Session Memory DB ID: ${sessionDbId}`);

      // 3. 로컬 캐시 기록 및 .gitignore 격리
      saveProjectCache(process.cwd(), {
        projectsDatabaseId: projectsDbId,
        sessionDatabaseId: sessionDbId
      });
      ensureGitignoreEntry(process.cwd(), '.session-memory/');
      ensureGitignoreEntry(process.cwd(), 'HANDOVER.md');

      // 4. 환경변수 가이드 또는 --write-env 명시 시 파일 갱신
      if (parsed.options['write-env']) {
        updateEnvFile('NOTION_PROJECTS_DATABASE_ID', projectsDbId);
        updateEnvFile('NOTION_DATABASE_ID', sessionDbId);
        console.log(`[ENV_UPDATE] Updated NOTION_PROJECTS_DATABASE_ID & NOTION_DATABASE_ID in .env`);
      } else {
        console.log(`\n================================================================`);
        console.log(`[ENV_GUIDE] Add the following to your local .env file:`);
        console.log(`NOTION_PROJECTS_DATABASE_ID=${projectsDbId}`);
        console.log(`NOTION_DATABASE_ID=${sessionDbId}`);
        console.log(`================================================================\n`);
      }
      break;
    }

    case 'push': {
      if (parsed.options.help) {
        console.log("Usage: session-sync push --file <PATH> [--phase <PHASE>] [--pass <NUM>] [--fail <NUM>] [--dry-run]");
        process.exit(0);
      }
      await executePush(parsed.options);
      try {
        const { IndexCache } = require('../lib/index-cache');
        const cache = new IndexCache();
        cache.loadOrBuildSync();
      } catch (_) {}
      break;
    }

    case 'fetch': {
      if (parsed.options.help) {
        console.log("Usage: session-sync fetch <--list | --latest | --diff> [--out <PATH>] [--verify] [--run-test] [--strict]");
        process.exit(0);
      }

      // 인출 전 로컬 파일 덮어쓰기 방지 백업
      if (parsed.options.latest || parsed.options.out) {
        const targetHandover = path.resolve(process.cwd(), parsed.options.out || 'HANDOVER.md');
        if (fs.existsSync(targetHandover)) {
          const backupDir = path.resolve(process.cwd(), '.session-memory', 'backups');
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
          const backupPath = path.join(backupDir, `HANDOVER.${Date.now()}.bak`);
          fs.copyFileSync(targetHandover, backupPath);
        }
      }

      await executeFetch(parsed.options);

      if (parsed.options.verify && (parsed.options.latest || parsed.options.out)) {
        const targetHandover = parsed.options.out || 'HANDOVER.md';
        executeVerify({
          file: targetHandover,
          runTest: Boolean(parsed.options['run-test']),
          strict: Boolean(parsed.options.strict)
        });
      }
      break;
    }

    case 'hook': {
      const action = parsed.subcommand || (parsed.options.install ? 'install' : (parsed.options.exec ? 'exec' : null));
      if (parsed.options.help || !action) {
        console.log("Usage: session-sync hook <install | exec> [options]");
        process.exit(0);
      }

      if (action === 'install') {
        installHook(process.cwd());
      } else if (action === 'exec') {
        await executeHook(parsed.options);
      } else {
        console.error(`Unknown hook action '${action}'. Expected 'install' or 'exec'.`);
        process.exit(1);
      }
      break;
    }

    case 'ci': {
      if (parsed.options.help) {
        console.log("Usage: session-sync ci [--test-cmd <CMD>] [--file <PATH>]");
        process.exit(0);
      }
      const ciResult = await runCiPipeline(parsed.options);
      process.exit(ciResult.exitCode);
      break;
    }

    case 'export': {
      if (parsed.options.help) {
        console.log("Usage: session-sync export [--file <PATH>] [--out <DIR>] [--list]");
        process.exit(0);
      }
      if (parsed.options.list) {
        const archives = listExportedArchives(parsed.options.out);
        console.log(`[ARCHIVES] Found ${archives.length} archive(s):`);
        for (const a of archives) {
          console.log(`  - ${a.file} (${a.sizeBytes} bytes)`);
        }
      } else {
        const handoverPath = path.resolve(process.cwd(), parsed.options.file || 'HANDOVER.md');
        if (!fs.existsSync(handoverPath)) {
          console.error(`File not found: ${handoverPath}`);
          process.exit(1);
        }
        const markdown = fs.readFileSync(handoverPath, 'utf8');
        exportSessionMarkdown({
          phase: parsed.options.phase || 'SNAPSHOT',
          commitHash: parsed.options.commit || 'manual-export',
          passCount: parsed.options.pass || 0,
          failCount: parsed.options.fail || 0,
          rawMarkdown: markdown
        }, parsed.options.out);
      }
      break;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, printUsage };
