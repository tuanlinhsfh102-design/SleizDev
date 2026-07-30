/**
 * Test the retry logic by forcing a failure.
 *
 * Submits a batch with one entry using a deliberately-invalid voice_type
 * so CapCut returns status=failed. Verifies the bridge retries it up to
 * max_retries times, then reports failure. The OTHER entry in the batch
 * should succeed normally — proving retries don't block other workers.
 */

import fs from 'fs';
import path from 'path';
import { generateSpeechBatch, type CapCutTtsBatchEntry } from '../src/capcut-tts.ts';

const TEST_DIR = path.resolve('./test-retry-tts');
fs.mkdirSync(TEST_DIR, { recursive: true });

async function main() {
  console.log('=== Retry Logic Test ===');
  console.log('Submitting 2 entries: 1 valid + 1 with invalid voice_type');
  console.log('Expected: valid succeeds, invalid retries 3x then fails');
  console.log('');

  const entries: CapCutTtsBatchEntry[] = [
    {
      output: path.join(TEST_DIR, 'valid.mp3'),
      text: 'Đây là một đoạn văn bản hợp lệ để kiểm tra retry logic.',
      voice: 'vi_vn_1',
      rate: '1.0',
    },
    {
      output: path.join(TEST_DIR, 'invalid.mp3'),
      text: 'Đoạn này sẽ fail vì voice_type không tồn tại.',
      voice: 'BV_NONEXISTENT_INVALID_VOICE_xyz123',  // deliberately invalid
      rate: '1.0',
    },
  ];

  const startMs = Date.now();
  const results = await generateSpeechBatch(entries, {
    timeoutSeconds: 60,
    maxRetries: 3,  // small for test speed
    concurrency: 2,
  });
  const durationSec = (Date.now() - startMs) / 1000;

  console.log(`\n=== Results (took ${durationSec.toFixed(1)}s) ===`);
  for (const r of results) {
    const status = r.success ? '✓ SUCCESS' : '✗ FAILED';
    console.log(`  [${r.idx}] ${status}: ${r.message}`);
  }

  // Assertions
  let pass = 0, fail = 0;
  const assert = (cond: boolean, msg: string) => {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}`); fail++; }
  };

  console.log('\n=== Assertions ===');
  assert(results.length === 2, `got 2 results (got ${results.length})`);

  // Valid entry should succeed
  const validResult = results.find(r => r.idx === 0);
  assert(!!validResult?.success, 'valid entry (idx=0) succeeded');

  // Invalid entry should fail (after retries)
  const invalidResult = results.find(r => r.idx === 1);
  assert(!invalidResult?.success, 'invalid entry (idx=1) failed (after retries)');

  // Invalid entry's failure message should mention "all N attempts failed"
  assert(
    invalidResult?.message.includes('attempts failed') === true,
    `invalid entry message mentions retry exhaustion: "${invalidResult?.message}"`
  );

  // Verify the valid MP3 was actually created
  assert(
    fs.existsSync(path.join(TEST_DIR, 'valid.mp3')) && fs.statSync(path.join(TEST_DIR, 'valid.mp3')).size > 100,
    'valid.mp3 was created and is non-empty'
  );

  // Verify the invalid MP3 was NOT created (or is empty)
  const invalidPath = path.join(TEST_DIR, 'invalid.mp3');
  assert(
    !fs.existsSync(invalidPath) || fs.statSync(invalidPath).size === 0,
    'invalid.mp3 was NOT created (or is empty) — failure not falsely reported as success'
  );

  // Timing check: with max_retries=3 and exponential backoff (2s, 4s),
  // the invalid entry should have taken at least ~6s of retry waiting.
  // But the valid entry should have completed in <5s. The total time
  // should be ~6-10s (the valid one finishes fast, the invalid one
  // waits through its retries).
  assert(
    durationSec >= 5,
    `total time >= 5s (got ${durationSec.toFixed(1)}s) — retries did happen`
  );

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);

  // Cleanup
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
