/**
 * Mock test for the Gemini translation pipeline.
 *
 * Stubs globalThis.fetch with a fake that returns a canned JSON response
 * matching the contract, then verifies:
 *   - Prompt is built correctly (contains user's exact prompt rules)
 *   - 100-line batching kicks in (only 1 request for 10 entries)
 *   - JSON response is parsed into SRT with original timing preserved
 *   - Conversation history is included in the prompt when provided
 *   - Original Chinese text is filled in for any missing translations
 */

import { translateSrt } from '../src/gemini.ts';

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  body: any;
}

const capturedRequests: CapturedRequest[] = [];

// Build a synthetic Chinese SRT
function buildTestSrt(): string {
  const entries = [
    [1, "00:00:00,120", "00:00:01,380", "大家好"],
    [2, "00:00:01,400", "00:00:04,580", "今天我们来聊一聊人工智能"],
    [3, "00:00:04,800", "00:00:07,780", "希望你们喜欢这个视频"],
    [4, "00:00:08,000", "00:00:10,500", "请点赞订阅我的频道"],
    [5, "00:00:10,700", "00:00:13,200", "下期节目再见"],
    [6, "00:00:13,400", "00:00:16,000", "我是你们的主播小明"],
    [7, "00:00:16,200", "00:00:18,800", "今天天气真不错"],
    [8, "00:00:19,000", "00:00:21,500", "我们一起去公园散步吧"],
    [9, "00:00:21,700", "00:00:24,200", "好的，我马上就来"],
    [10, "00:00:24,400", "00:00:27,000", "太棒了，我们出发吧"],
  ];
  return entries
    .map(([idx, start, end, text]) => `${idx}\n${start} --> ${end}\n${text}`)
    .join("\n\n") + "\n";
}

// Build a mock Gemini JSON response with Vietnamese translations.
// The real Gemini API wraps the model output in candidates[].content.parts[].
function buildMockResponse(segments: Array<{ index: number; text: string }>): string {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify({ segments }) }],
        },
        finishReason: "STOP",
      },
    ],
  });
}

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

async function testBasicTranslation() {
  console.log("\n=== Test 1: Basic translation (10 entries, 1 batch) ===");
  capturedRequests.length = 0;

  const mockTranslations = [
    { index: 1, text: "Xin chào mọi người" },
    { index: 2, text: "Hôm nay chúng ta sẽ nói về trí tuệ nhân tạo" },
    { index: 3, text: "Hy vọng các bạn thích video này" },
    { index: 4, text: "Hãy like và đăng ký kênh của tôi" },
    { index: 5, text: "Hẹn gặp lại trong chương trình tiếp theo" },
    { index: 6, text: "Tôi là MC Tiểu Minh của các bạn" },
    { index: 7, text: "Hôm nay thời tiết thật đẹp" },
    { index: 8, text: "Chúng ta cùng đi dạo trong công viên nhé" },
    { index: 9, text: "Được rồi, tôi đến ngay" },
    { index: 10, text: "Tuyệt quá, chúng ta xuất phát thôi" },
  ];

  globalThis.fetch = ((url: any, init: any) => {
    capturedRequests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve(
      new Response(buildMockResponse(mockTranslations), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as any;

  const result = await translateSrt(buildTestSrt(), "fake-key", {
    conversationHistory: [],
  });

  // 1. Should make exactly 1 API call (10 entries fit in 1 batch of 100)
  assert(capturedRequests.length === 1, "made exactly 1 API call (batched)");

  // 2. Result should contain 10 entries
  const resultLines = result.trim().split("\n");
  const entryCount = resultLines.filter((l) => /^\d+$/.test(l.trim())).length;
  assert(entryCount === 10, `result has 10 entries (got ${entryCount})`);

  // 3. Original timing should be preserved
  assert(result.includes("00:00:00,120 --> 00:00:01,380"), "first entry timing preserved");
  assert(result.includes("00:00:24,400 --> 00:00:27,000"), "last entry timing preserved");

  // 4. Text should be Vietnamese (no Chinese characters)
  assert(!/[\u4e00-\u9fff]/.test(result), "no Chinese characters in result");
  assert(result.includes("Xin chào mọi người"), "first translation present");
  assert(result.includes("Tuyệt quá, chúng ta xuất phát thôi"), "last translation present");

  // 5. Prompt should contain the user's exact rules
  const prompt = capturedRequests[0].body.contents[0].parts[0].text;
  assert(prompt.includes("professional Vietnamese subtitle translator"), "prompt has professional translator role");
  assert(prompt.includes("Remove all Chinese characters from the output"), "prompt has remove-Chinese rule");
  assert(prompt.includes('{"segments":[{"index":1,"text":'), "prompt has JSON output format");
  assert(prompt.includes("The number of output segments must equal the number of input segments"), "prompt has 1:1 segment rule");
  assert(prompt.includes("Never return empty strings"), "prompt has no-empty-strings rule");

  // 6. responseMimeType should be application/json
  assert(
    capturedRequests[0].body.generationConfig.responseMimeType === "application/json",
    "request uses responseMimeType: application/json"
  );
}

async function testConversationHistory() {
  console.log("\n=== Test 2: Conversation history is included in prompt ===");
  capturedRequests.length = 0;

  globalThis.fetch = ((url: any, init: any) => {
    capturedRequests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve(
      new Response(buildMockResponse([{ index: 1, text: "Xin chào" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as any;

  const singleEntrySrt = "1\n00:00:00,000 --> 00:00:02,000\n大家好\n";
  await translateSrt(singleEntrySrt, "fake-key", {
    conversationHistory: [
      "1\n00:00:00,000 --> 00:00:02,000\nXin chào\n",
      "1\n00:00:00,000 --> 00:00:02,000\nTạm biệt\n",
    ],
  });

  const prompt = capturedRequests[0].body.contents[0].parts[0].text;
  assert(prompt.includes("Previous episode translations"), "prompt includes history header");
  assert(prompt.includes("Episode 1"), "prompt includes Episode 1");
  assert(prompt.includes("Episode 2"), "prompt includes Episode 2");
  assert(prompt.includes("Xin chào"), "prompt includes first episode translation");
  assert(prompt.includes("Tạm biệt"), "prompt includes second episode translation");
}

async function testMissingTranslationFallback() {
  console.log("\n=== Test 3: Missing translations fall back to original text ===");
  capturedRequests.length = 0;

  // Mock returns only 7 of 10 translations — indexes 4, 7, 9 are missing
  const partialTranslations = [
    { index: 1, text: "Xin chào mọi người" },
    { index: 2, text: "Hôm nay nói về AI" },
    { index: 3, text: "Hy vọng các bạn thích" },
    // 4 missing
    { index: 5, text: "Hẹn gặp lại" },
    { index: 6, text: "Tôi là MC Tiểu Minh" },
    // 7 missing
    { index: 8, text: "Đi dạo công viên nhé" },
    // 9 missing
    { index: 10, text: "Xuất phát thôi" },
  ];

  globalThis.fetch = ((url: any, init: any) => {
    capturedRequests.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve(
      new Response(buildMockResponse(partialTranslations), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as any;

  const result = await translateSrt(buildTestSrt(), "fake-key", {
    conversationHistory: [],
  });

  // Result should still have 10 entries (no lines dropped)
  const entryCount = result.trim().split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
  assert(entryCount === 10, `result still has 10 entries (got ${entryCount})`);

  // Missing translations should keep the original Chinese text
  assert(result.includes("请点赞订阅我的频道"), "entry 4 keeps original (missing translation)");
  assert(result.includes("今天天气真不错"), "entry 7 keeps original (missing translation)");
  assert(result.includes("好的，我马上就来"), "entry 9 keeps original (missing translation)");

  // Present translations should still be Vietnamese
  assert(result.includes("Xin chào mọi người"), "entry 1 still translated");
  assert(result.includes("Xuất phát thôi"), "entry 10 still translated");
}

async function testBatching100() {
  console.log("\n=== Test 4: 250 entries split into 3 batches (100/100/50) ===");
  capturedRequests.length = 0;

  // Build a 250-entry SRT
  const entries: string[] = [];
  const fmt = (totalSec: number) => {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const ms = Math.floor((totalSec % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  for (let i = 1; i <= 250; i++) {
    const startSec = (i - 1) * 2;
    const endSec = i * 2 - 0.5;
    entries.push(`${i}\n${fmt(startSec)} --> ${fmt(endSec)}\n这是第${i}句话\n`);
  }
  const bigSrt = entries.join("\n");

  globalThis.fetch = ((url: any, init: any) => {
    capturedRequests.push({ url: String(url), body: JSON.parse(init.body) });
    // Echo back translations for whatever was in the prompt
    const parsedBody = JSON.parse(init.body);
    const prompt = parsedBody.contents[0].parts[0].text as string;
    const match = prompt.match(/"index":\s*(\d+)/g) || [];
    const indexes = match.map((m) => parseInt(m.match(/\d+/)![0]));
    const segments = indexes.map((idx) => ({
      index: idx,
      text: `Dịch ${idx}`,
    }));
    return Promise.resolve(
      new Response(buildMockResponse(segments), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as any;

  const result = await translateSrt(bigSrt, "fake-key", {
    conversationHistory: [],
  });

  // Should make exactly 3 API calls (250 / 100 = 3 batches: 100+100+50)
  assert(capturedRequests.length === 3, `made 3 API calls for 250 entries (got ${capturedRequests.length})`);

  // Result should have 250 entries
  const entryCount = result.trim().split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
  assert(entryCount === 250, `result has 250 entries (got ${entryCount})`);
}

async function main() {
  console.log("=== Gemini Translation Pipeline — Mock Tests ===");
  try {
    await testBasicTranslation();
    await testConversationHistory();
    await testMissingTranslationFallback();
    await testBatching100();
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    process.exit(1);
  }
}

main();
