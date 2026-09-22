#!/usr/bin/env node

/**
 * session-sync CLI 엔트리포인트
 * Zero-dependency Node.js CLI for Agent Session Memory & Notion Sync
 */

const path = require('node:path');
const fs = require('node:fs');
const { executePush, executeFetch, getDatabaseSchema } = require('../lib/sync-engine');
const { NotionClient } = require('../lib/notion-client');

function printUsage() {
  const usage = `
Usage: session-sync <command> [options]

Commands:
  init   빈 Notion 페이지 하위에 세션 메모리 Database 스키마 구축
  push   현재 세션 작업물(HANDOVER.md, ADR 등)을 Notion DB 및 로컬 캐시에 적재
  fetch  Notion DB에서 세션 인덱스(목차) 또는 인수인계 본문 인출

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
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
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
    console.error("Error: Subcommand missing. Expected 'init', 'push', or 'fetch'.");
    process.exit(1);
  }

  const validCommands = ['init', 'push', 'fetch'];
  if (!validCommands.includes(parsed.command)) {
    console.error(`Error: Unknown command '${parsed.command}'.`);
    console.error("Available commands: init, push, fetch");
    process.exit(1);
  }

  switch (parsed.command) {
    case 'init': {
      if (parsed.options.help) {
        console.log("Usage: session-sync init --parent <PAGE_URL_OR_ID>");
        process.exit(0);
      }
      const parent = parsed.options.parent || process.env.NOTION_PARENT_PAGE_ID;
      if (!parent) {
        console.error("Error: Missing --parent <PAGE_ID_OR_URL>");
        process.exit(1);
      }
      const client = new NotionClient();
      const schema = getDatabaseSchema();
      console.log(`[INIT] Creating Notion Database under parent: ${parent}...`);
      const res = await client.createDatabase(parent, schema);
      console.log(`[INIT_SUCCESS] Created Database ID: ${res.data.id}`);
      break;
    }
    case 'push': {
      if (parsed.options.help) {
        console.log("Usage: session-sync push --file <PATH> [--phase <PHASE>] [--pass <NUM>] [--fail <NUM>] [--dry-run]");
        process.exit(0);
      }
      await executePush(parsed.options);
      break;
    }
    case 'fetch': {
      if (parsed.options.help) {
        console.log("Usage: session-sync fetch <--list | --latest | --tag <TAG>> [--out <PATH>]");
        process.exit(0);
      }
      await executeFetch(parsed.options);
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
