// Gemini API integration
// Uses Gemini 2.5 Flash (with 2.0 Flash fallback) for SRT translation and
// description generation.
//
// Translation strategy:
//   - Each SRT is split into batches of BATCH_SIZE entries (default 100) to
//     conserve API quota — translating one line per request would burn
//     through the free tier in minutes.
//   - Each batch is sent as a single Gemini request with a strict JSON
//     output contract ({"segments":[{"index":N,"text":"..."}]}).
//   - Previous episode Vietnamese translations can be passed in as
//     conversation history so character names / nicknames / titles stay
//     consistent across episodes.
//   - Model fallback: gemini-2.5-flash → gemini-2.0-flash. Newer models
//     are sometimes geo-restricted ("User location is not supported"); the
//     fallback gives the pipeline a second chance on older models.

import { SrtEntry, parseSrt, formatSrt } from './srt-utils.js';

// Models tried in order. Override the entire list with GEMINI_MODELS env
// (comma-separated), or pin a single model with GEMINI_MODEL.
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const GEMINI_MODELS = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : process.env.GEMINI_MODELS?.split(',').map((s) => s.trim()).filter(Boolean)
) || DEFAULT_MODELS;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Lines per Gemini request. Higher = fewer requests = less quota burn. */
const BATCH_SIZE = parseInt(process.env.GEMINI_BATCH_SIZE || '100', 10);

interface GeminiResponse {
  candidates?: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

interface TranslatedSegment {
  index: number;
  text: string;
}

export interface TranslateSrtOptions {
  /** Previous Vietnamese translations from earlier episodes of the same
   *  channel/show — used to keep names and tone consistent. */
  conversationHistory?: string[];
  /** Optional caller-supplied progress callback. */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Translate SRT content from Chinese to Vietnamese using Gemini.
 *
 * Batches BATCH_SIZE entries per API call to conserve quota. Optionally
 * includes previous Vietnamese SRT strings as conversation history so
 * character names, titles, and tone stay consistent across episodes.
 */
export async function translateSrt(
  srtContent: string,
  apiKey: string,
  options: TranslateSrtOptions = {}
): Promise<string> {
  const { conversationHistory = [], onProgress } = options;

  const entries = parseSrt(srtContent);
  if (entries.length === 0) {
    throw new Error('No SRT entries to translate');
  }

  console.log(
    `[gemini] Translating ${entries.length} entries in batches of ${BATCH_SIZE}...`
  );

  const translatedEntries: SrtEntry[] = [];

  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entries.length / BATCH_SIZE);

    onProgress?.(batchNum - 1, totalBatches);
    console.log(
      `[gemini] Batch ${batchNum}/${totalBatches}: ${batch.length} entries (lines ${start + 1}-${start + batch.length})`
    );

    const prompt = buildTranslationPrompt(batch, conversationHistory);
    let translatedText: string;
    try {
      translatedText = await callGemini(apiKey, prompt, batch.length);
    } catch (err: any) {
      // If the batch fails, surface a clear error with the batch context
      // so the user knows which lines were lost.
      throw new Error(
        `Batch ${batchNum}/${totalBatches} failed: ${err.message} ` +
          `(entries ${start + 1}-${start + batch.length})`
      );
    }

    const translatedBatch = parseTranslatedSegments(translatedText, batch);

    // Warn (but continue) if Gemini dropped any lines — the contract
    // demands a 1:1 mapping, so a partial batch means we fall back to
    // the original Chinese for the missing entries rather than skip them.
    if (translatedBatch.length < batch.length) {
      console.warn(
        `[gemini] Batch ${batchNum}: only got ${translatedBatch.length}/${batch.length} translations, ` +
          'filling missing slots with original text'
      );
    }
    translatedEntries.push(...translatedBatch);

    // Small delay between batches to avoid 429s on the free tier.
    if (start + BATCH_SIZE < entries.length) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  onProgress?.(Math.ceil(entries.length / BATCH_SIZE), Math.ceil(entries.length / BATCH_SIZE));
  return formatSrt(translatedEntries);
}

/**
 * Build the translation prompt for a single batch.
 *
 * The prompt enforces:
 *   - JSON-only output (no markdown, no commentary)
 *   - 1:1 index correspondence with the input
 *   - No empty / placeholder translations
 *   - Consistency with previous episode translations when provided
 */
function buildTranslationPrompt(
  entries: SrtEntry[],
  conversationHistory: string[]
): string {
  const segmentsJson = JSON.stringify(
    entries.map((e) => ({ index: e.index, text: e.text })),
    null,
    2
  );

  const historyBlock =
    conversationHistory.length > 0
      ? `\n\nPrevious episode translations (use these to keep character names, nicknames, titles, relationships, and speaking style consistent):\n\n${conversationHistory
          .map((s, i) => `--- Episode ${i + 1} ---\n${s}`)
          .join('\n\n')}\n\n--- End of previous translations ---\n`
      : '';

  return `You are a professional Vietnamese subtitle translator.

You have access to previous episode translations as conversation history. Use them to maintain consistency for character names, nicknames, titles, relationships, and speaking style.

Requirements:

* Translate every subtitle segment from Chinese to Vietnamese.
* Remove all Chinese characters from the output.
* Keep names, nicknames, titles, and forms of address consistent with previous translations whenever available.
* If a name, title, or term of address has not appeared before, choose a natural Vietnamese equivalent and remain consistent within the current response.
* Subtitles must be concise and suitable for on-screen timing.
* Use natural spoken Vietnamese. Avoid overly formal, literary, or unnecessarily Sino-Vietnamese wording.
* Preserve the original meaning, tone, emotion, and intent.
* Do not censor, soften, summarize, or reinterpret content.
* Translate everything exactly as intended by the source.
* Keep line-by-line correspondence. Do not merge, split, reorder, or omit segments.
* Every segment MUST contain meaningful translated text.
* Never return empty strings or such as "." not have any text in it.
* Never use placeholders such as ".", "...", "-", "[inaudible]", "[unknown]", or similar unless they are explicitly present in the source dialogue and should be translated.
* If the source contains only a name, exclamation, reaction, or interjection, translate it naturally rather than leaving it empty.
* Include ALL segments from the input.

Output rules:

* Respond with valid JSON only.
* Do not include Markdown.
* Do not include explanations, notes, comments, or extra text.
* The response format must be:

{"segments":[{"index":1,"text":"Vietnamese sentence"},{"index":2,"text":"Vietnamese sentence"}]}

* Preserve the original index values exactly.
* Include every segment exactly once.
* The number of output segments must equal the number of input segments.
* Every "text" field must contain a non-empty Vietnamese translation.${historyBlock}

Input segments (translate ALL of them, preserving indexes):

${segmentsJson}`;
}

/**
 * Call Gemini API with a text prompt.
 *
 * Tries each model in GEMINI_MODELS in order:
 *   - 429 / 5xx: retry the SAME model with exponential backoff (up to 3x)
 *   - 400 "User location is not supported": skip to next model (geo block)
 *   - other 4xx: throw immediately (bad request, won't fix by retrying)
 *   - network error: retry the same model with backoff
 *
 * If all models fail, throws the most informative error found.
 */
async function callGemini(
  apiKey: string,
  prompt: string,
  expectedSegmentCount: number
): Promise<string> {
  // Rough token budget: ~80 tokens per segment for Vietnamese output.
  // Capped at 32768 (model max for 2.5-flash).
  const maxOutputTokens = Math.min(
    32768,
    Math.max(4096, expectedSegmentCount * 80)
  );

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.95,
      maxOutputTokens,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const errors: string[] = [];

  for (const model of GEMINI_MODELS) {
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();

          // Geo-restriction: this model is blocked in this region. Try
          // the next model — no point retrying the same one.
          if (
            response.status === 400 &&
            errorText.includes('User location is not supported')
          ) {
            errors.push(`${model}: geo-blocked (User location is not supported)`);
            console.warn(
              `[gemini] ${model} is geo-blocked in this region, trying next model...`
            );
            lastError = null; // not a retryable error for THIS model
            break; // exit attempt loop, fall through to next model
          }

          // Rate limit or server error: retry same model with backoff
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < 2
          ) {
            const waitMs = 2000 * Math.pow(2, attempt);
            console.warn(
              `[gemini] ${model} HTTP ${response.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/3)...`
            );
            await new Promise((r) => setTimeout(r, waitMs));
            lastError = new Error(
              `Gemini API error (${response.status}): ${errorText.substring(0, 300)}`
            );
            continue;
          }

          // Quota exhausted on this key for this model — try the next
          // model rather than retrying (different models have separate quotas).
          if (response.status === 429) {
            errors.push(
              `${model}: quota exhausted (${errorText.substring(0, 150)})`
            );
            console.warn(
              `[gemini] ${model} quota exhausted, trying next model...`
            );
            lastError = null;
            break;
          }

          // Non-retryable client error (bad request, auth, etc.)
          throw new Error(
            `Gemini API error (${response.status}): ${errorText.substring(0, 300)}`
          );
        }

        const data = (await response.json()) as GeminiResponse;

        if (data.error) {
          throw new Error(`Gemini error: ${data.error.message}`);
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          const finishReason = data.candidates?.[0]?.finishReason;
          throw new Error(
            `Gemini returned empty response (finishReason=${finishReason || 'unknown'})`
          );
        }

        return text;
      } catch (err: any) {
        // Network errors get retried; the "geo-blocked" break above is
        // already handled. Anything else with a Gemini error message is
        // a hard fail.
        if (err.message?.includes('Gemini')) {
          throw err;
        }
        if (attempt < 2) {
          const waitMs = 1000 * Math.pow(2, attempt);
          console.warn(
            `[gemini] ${model} network error, retrying in ${waitMs}ms: ${err.message}`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          lastError = err;
          continue;
        }
        lastError = err;
      }
    }

    // If we got here with a real error, record it and try the next model.
    if (lastError) {
      errors.push(`${model}: ${lastError.message}`);
      console.warn(`[gemini] ${model} failed: ${lastError.message}`);
    }
  }

  // All models failed.
  const geoBlocked = errors.some((e) => e.includes('geo-blocked'));
  const allQuota = errors.every((e) => e.includes('quota') || e.includes('geo-blocked'));

  if (geoBlocked && allQuota) {
    throw new Error(
      `All Gemini models failed.\n` +
        errors.map((e) => `  - ${e}`).join('\n') +
        `\n\nThis server's region is geo-blocked for newer Gemini models AND ` +
        `quota is exhausted on older models. Either:\n` +
        `  (a) Run this service from a supported region (Vietnam works), or\n` +
        `  (b) Enable billing on the Google Cloud project tied to your API key ` +
        `(paid tier has no geo restrictions), or\n` +
        `  (c) Wait for the free-tier quota to reset (usually daily).`
    );
  }

  throw new Error(
    `All Gemini models failed:\n` + errors.map((e) => `  - ${e}`).join('\n')
  );
}

/**
 * Parse Gemini's JSON response into translated SRT entries.
 *
 * Expected format: {"segments":[{"index":N,"text":"..."}]}
 *
 * Falls back to mapping whatever segments we did get onto the original
 * entries, preserving original timing. Missing segments keep their
 * original (Chinese) text so the SRT count never drops.
 */
function parseTranslatedSegments(
  translatedText: string,
  originalChunk: SrtEntry[]
): SrtEntry[] {
  let cleanText = translatedText.trim();

  // Strip markdown code fences if Gemini ignored the JSON-only rule.
  if (cleanText.startsWith('```')) {
    cleanText = cleanText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  let segments: TranslatedSegment[] = [];
  try {
    const parsed = JSON.parse(cleanText);
    if (Array.isArray(parsed?.segments)) {
      segments = parsed.segments.filter(
        (s: any) => s && typeof s.text === 'string'
      );
    } else if (Array.isArray(parsed)) {
      // Some models drop the wrapper — handle gracefully.
      segments = parsed.filter(
        (s: any) => s && typeof s.text === 'string'
      );
    }
  } catch (err: any) {
    // Last-ditch regex extraction in case the model wrapped JSON in prose.
    const match = cleanText.match(/\{[\s\S]*"segments"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed?.segments)) {
          segments = parsed.segments;
        }
      } catch {
        // fall through
      }
    }
    if (segments.length === 0) {
      console.error('[gemini] Failed to parse JSON response:', err.message);
      console.error('[gemini] Raw response (first 500 chars):', cleanText.substring(0, 500));
      // Return originals so the SRT keeps its line count.
      return originalChunk;
    }
  }

  // Build a lookup by index so we can map translations back to original
  // entries regardless of order. If Gemini omitted the index, fall back
  // to positional mapping.
  const byIndex = new Map<number, string>();
  segments.forEach((s, i) => {
    const text = (s.text || '').trim();
    if (text) {
      const idx = typeof s.index === 'number' ? s.index : parseInt(String(s.index), 10);
      if (!isNaN(idx)) {
        byIndex.set(idx, text);
      } else {
        // Positional fallback
        byIndex.set(originalChunk[i]?.index ?? i + 1, text);
      }
    }
  });

  return originalChunk.map((orig) => ({
    ...orig,
    text: byIndex.get(orig.index) || orig.text,
  }));
}

/**
 * Generate AI description for a movie from its Vietnamese SRT.
 * (Unchanged from previous implementation.)
 */
export async function generateMovieDescription(
  srtContent: string,
  movieTitle: string,
  episode: string,
  apiKey: string
): Promise<string> {
  const truncatedSrt =
    srtContent.length > 5000
      ? srtContent.substring(0, 5000) + '\n... (còn tiếp)'
      : srtContent;

  const prompt = `Bạn là một biên tập viên nội dung cho kênh dịch phim hoạt hình Trung Quốc (donghua). 

Nhiệm vụ: Tạo mô tả tập phim dựa trên phụ đề tiếng Việt, theo ĐÚNG mẫu dưới đây.

THÔNG TIN PHIM:
- Tên phim: ${movieTitle}
- Tập: ${episode}
- Kênh: Sleiz Vietsub

MẪU MÔ TẢ (bạn PHẢI tuân theo cấu trúc này, nhưng nội dung tóm tắt phải dựa trên phụ đề thực tế):

Chúc Các Bạn Xem Phim Vui Vẻ! ❤️

━━━━━━━━━━━━━━━━━━━━━━

🎬 Tên Phim: ${movieTitle}
🎞️ Tập: ${episode}
🎥 Vietsub & Biên Tập: Sleiz Vietsub
📱 TikTok: @sleiz.vietsub

━━━━━━━━━━━━━━━━━━━━━━

💖 ỦNG HỘ SLEIZ VIETSUB

🏦 Ngân hàng: MB BANK
💳 STK: 998809062005

Mọi sự ủng hộ từ các bạn sẽ là động lực để Sleiz Vietsub tiếp tục dịch và mang đến nhiều bộ phim chất lượng hơn trong tương lai. Xin chân thành cảm ơn tất cả mọi người đã luôn theo dõi và ủng hộ kênh! ❤️

━━━━━━━━━━━━━━━━━━━━━━

📌 Giới thiệu tập mới

[TẠO 2-3 ĐOẠN TÓM TẮT NỘI DUNG TẬP PHIM DỰA TRÊN PHỤ ĐỀ. Mỗi đoạn 3-5 câu. Trình bày các sự kiện chính, xung đột, và câu hỏi bỏ ngỏ để khán giả tò mò. Thêm emoji phù hợp 👑⚔️🍎🔥 etc.]

Đừng bỏ lỡ tập phim với hàng loạt diễn biến bất ngờ và những màn đấu trí cực kỳ hấp dẫn!

✨ Những điểm nổi bật không thể bỏ qua:

[6-8 GỢI Ý ĐIỂM NHẤN DẠNG BULLET POINT, mỗi điểm một dòng ngắn]

━━━━━━━━━━━━━━━━━━━━━━

🏷️ Hashtag:

[TẠO 20-30 HASHTAG LIÊN QUAN: #TênPhim #TênPhim${episode} #TênPhimVietsub #Donghua #DonghuaVietsub #HoatHinhTrungQuoc #ChineseAnime #Anime3D #Cultivation #MartialArts #Fantasy #Action #EpicBattle #AnimeVietsub #PhimTrungQuoc #ReviewPhim #TomTatPhim #AnimeHay #SleizVietsub #Sleiz và các hashtag nhân vật/yếu tố cụ thể trong tập]

👍 Like • 💬 Comment • 🔔 Đăng ký kênh để không bỏ lỡ những tập mới nhất từ Sleiz Vietsub!

---

PHỤ ĐỀ GỐC (để bạn tóm tắt nội dung):

${truncatedSrt}

QUAN TRỌNG:
- Tạo nội dung DỰA TRÊN phụ đề thực tế, không bịa chuyện
- Tuân thủ ĐÚNG cấu trúc mẫu (giữ nguyên các đường kẻ ━━━, các phần header)
- Sử dụng tiếng Việt tự nhiên, lôi cuốn
- Hashtag phải có dấu # và cách nhau bằng khoảng trắng
- Trả về TOÀN BỘ mô tả hoàn chỉnh, không kèm giải thích`;

  const result = await callGemini(apiKey, prompt, 200);

  let cleanResult = result.trim();
  if (cleanResult.startsWith('```')) {
    cleanResult = cleanResult
      .replace(/^```(?:markdown|text)?\n?/, '')
      .replace(/\n?```$/, '');
  }

  return cleanResult;
}

/**
 * Test Gemini API key validity with a minimal request.
 * Tries each configured model until one succeeds.
 */
export async function testGeminiApiKey(apiKey: string): Promise<boolean> {
  for (const model of GEMINI_MODELS) {
    try {
      const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hello' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      });
      if (response.ok) return true;
    } catch {
      // try next model
    }
  }
  return false;
}
