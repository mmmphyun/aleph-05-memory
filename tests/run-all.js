/**
 * 전체 테스트 슈트 실행 러너 (npm test 연동)
 */

const { execSync } = require('node:child_process');

const testSuites = [
  'tests/test-cli-routing.js',
  'tests/test-parser.js',
  'tests/test-transformer.js',
  'tests/test-secret-scanner.js',
  'tests/test-cache.js',
  'tests/test-notion-client.js',
  'tests/test-e2e-sync.js',
  'tests/test-project-metadata.js',
  'tests/test-pending-queue.js',
  'tests/test-git-hook.js',
  'tests/test-diff-engine.js',
  'tests/test-exporter.js',
  'tests/test-scaffold.js',
  'tests/test-doctor.js',
  'tests/test-search-engine.js',
  'tests/test-verifier.js'
];

console.log('================================================================');
console.log('  RUNNING ALL SESSION-SYNC UNIT & INTEGRATION TESTS');
console.log('================================================================\n');

let failed = false;

for (const suite of testSuites) {
  try {
    console.log(`>>> Executing: node ${suite}`);
    execSync(`node "${suite}"`, { stdio: 'inherit' });
    console.log('');
  } catch (err) {
    console.error(`\n[SUITE_FAIL] Failed on ${suite}`);
    failed = true;
    break;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log('================================================================');
  console.log('  ALL TEST SUITES PASSED (GREEN STATE VERIFIED)');
  console.log('================================================================');
}
