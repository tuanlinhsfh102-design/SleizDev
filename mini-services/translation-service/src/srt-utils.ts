// SRT utility functions - parse and format SRT files

export interface SrtEntry {
  index: number;
  start: string; // HH:MM:SS,mmm
  end: string;   // HH:MM:SS,mmm
  text: string;
}

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Parse SRT content into structured entries
 */
export function parseSrt(content: string): SrtEntry[] {
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalizedContent) return [];

  const blocks = normalizedContent.split(/\n\s*\n/);
  const entries: SrtEntry[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;

    let index = parseInt(lines[0], 10);
    if (isNaN(index)) {
      // Some SRTs may not have index numbers
      index = entries.length + 1;
      lines.unshift(String(index));
    }

    const timeLine = lines[1];
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!timeMatch) continue;

    const start = timeMatch[1].replace('.', ',');
    const end = timeMatch[2].replace('.', ',');
    const text = lines.slice(2).join('\n').trim();

    entries.push({ index, start, end, text });
  }

  return entries;
}

/**
 * Convert SRT time format to milliseconds
 */
export function timeToMs(time: string): number {
  const match = time.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return (
    parseInt(h, 10) * 3600000 +
    parseInt(m, 10) * 60000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms, 10)
  );
}

/**
 * Convert milliseconds to SRT time format
 */
export function msToTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/**
 * Convert entries to cues with millisecond timing
 */
export function entriesToCues(entries: SrtEntry[]): SrtCue[] {
  return entries.map((e) => ({
    index: e.index,
    startMs: timeToMs(e.start),
    endMs: timeToMs(e.end),
    text: e.text,
  }));
}

/**
 * Format entries back to SRT string
 */
export function formatSrt(entries: SrtEntry[]): string {
  return entries
    .map((e) => `${e.index}\n${e.start} --> ${e.end}\n${e.text}`)
    .join('\n\n');
}

/**
 * Group SRT entries into chunks for translation (to avoid token limits)
 * Each chunk will be translated as a batch
 */
export function chunkEntries(entries: SrtEntry[], maxChunkSize = 30): SrtEntry[][] {
  const chunks: SrtEntry[][] = [];
  for (let i = 0; i < entries.length; i += maxChunkSize) {
    chunks.push(entries.slice(i, i + maxChunkSize));
  }
  return chunks;
}

/**
 * Generate a simple VTT from SRT entries (for video preview)
 */
export function srtToVtt(entries: SrtEntry[]): string {
  const vtt = ['WEBVTT', ''];
  for (const e of entries) {
    vtt.push(
      `${e.start.replace(',', '.')} --> ${e.end.replace(',', '.')}`,
      e.text,
      ''
    );
  }
  return vtt.join('\n');
}
