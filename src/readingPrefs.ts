import type { CSSProperties } from "react";

export const READER_FONTS = [
  {
    id: "serif",
    label: "衬线（Iowan）",
    family:
      '"Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Source Han Serif SC", serif',
  },
  {
    id: "palatino",
    label: "Palatino",
    family: 'Palatino, "Palatino Linotype", "Songti SC", serif',
  },
  {
    id: "georgia",
    label: "Georgia",
    family: 'Georgia, "Songti SC", serif',
  },
  {
    id: "newyork",
    label: "New York",
    family: '"New York", "Iowan Old Style", "Songti SC", serif',
  },
  {
    id: "songti",
    label: "宋体",
    family: '"Songti SC", "Source Han Serif SC", Palatino, serif',
  },
  {
    id: "sans",
    label: "无衬线",
    family:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif',
  },
] as const;

export type ReaderFontId = (typeof READER_FONTS)[number]["id"];

export const READER_FONT_SIZES = [
  { value: 16, label: "16 · 小" },
  { value: 18, label: "18 · 标准" },
  { value: 20, label: "20 · 大" },
  { value: 22, label: "22 · 较大" },
  { value: 24, label: "24 · 特大" },
] as const;

export type ReaderFontSize = (typeof READER_FONT_SIZES)[number]["value"];

export const READER_LINE_HEIGHTS = [
  { value: 1.5, label: "紧凑 1.5" },
  { value: 1.65, label: "适中 1.65" },
  { value: 1.75, label: "标准 1.75" },
  { value: 1.9, label: "宽松 1.9" },
  { value: 2.1, label: "很松 2.1" },
] as const;

export type ReaderLineHeight = (typeof READER_LINE_HEIGHTS)[number]["value"];

export const READER_LINE_WIDTHS = [
  { id: "narrow", label: "窄", measure: "58ch" },
  { id: "medium", label: "适中", measure: "68ch" },
  { id: "wide", label: "宽", measure: "80ch" },
  { id: "full", label: "全宽", measure: "none" },
] as const;

export type ReaderLineWidthId = (typeof READER_LINE_WIDTHS)[number]["id"];

export type ReadingPrefs = {
  reader_font: ReaderFontId;
  reader_font_size: ReaderFontSize;
  reader_line_height: ReaderLineHeight;
  reader_line_width: ReaderLineWidthId;
};

export type ResolvedReading = {
  fontId: ReaderFontId;
  fontFamily: string;
  fontSizePx: ReaderFontSize;
  lineHeight: ReaderLineHeight;
  lineWidthId: ReaderLineWidthId;
  measure: string;
  fullWidth: boolean;
};

const FONT_IDS = new Set<string>(READER_FONTS.map((f) => f.id));
const FONT_SIZES = new Set<number>(READER_FONT_SIZES.map((s) => s.value));
const LINE_HEIGHTS = new Set<number>(READER_LINE_HEIGHTS.map((h) => h.value));
const LINE_WIDTHS = new Set<string>(READER_LINE_WIDTHS.map((w) => w.id));

export function defaultReadingPrefs(): ReadingPrefs {
  return {
    reader_font: "serif",
    reader_font_size: 18,
    reader_line_height: 1.75,
    reader_line_width: "medium",
  };
}

export function isReaderFontId(v: unknown): v is ReaderFontId {
  return typeof v === "string" && FONT_IDS.has(v);
}

export function isReaderFontSize(v: unknown): v is ReaderFontSize {
  return typeof v === "number" && FONT_SIZES.has(v);
}

export function isReaderLineHeight(v: unknown): v is ReaderLineHeight {
  return typeof v === "number" && LINE_HEIGHTS.has(v);
}

export function isReaderLineWidthId(v: unknown): v is ReaderLineWidthId {
  return typeof v === "string" && LINE_WIDTHS.has(v);
}

export function normalizeReadingPrefs(
  raw: Partial<ReadingPrefs> | null | undefined,
): ReadingPrefs {
  const fallback = defaultReadingPrefs();
  return {
    reader_font: isReaderFontId(raw?.reader_font)
      ? raw.reader_font
      : fallback.reader_font,
    reader_font_size: isReaderFontSize(raw?.reader_font_size)
      ? raw.reader_font_size
      : fallback.reader_font_size,
    reader_line_height: isReaderLineHeight(raw?.reader_line_height)
      ? raw.reader_line_height
      : fallback.reader_line_height,
    reader_line_width: isReaderLineWidthId(raw?.reader_line_width)
      ? raw.reader_line_width
      : fallback.reader_line_width,
  };
}

export function resolveReadingPrefs(
  raw: Partial<ReadingPrefs> | null | undefined,
): ResolvedReading {
  const prefs = normalizeReadingPrefs(raw);
  const font = READER_FONTS.find((f) => f.id === prefs.reader_font) ?? READER_FONTS[0];
  const width =
    READER_LINE_WIDTHS.find((w) => w.id === prefs.reader_line_width) ??
    READER_LINE_WIDTHS[1];
  return {
    fontId: font.id,
    fontFamily: font.family,
    fontSizePx: prefs.reader_font_size,
    lineHeight: prefs.reader_line_height,
    lineWidthId: width.id,
    measure: width.measure,
    fullWidth: width.id === "full",
  };
}

export function readingCssVars(resolved: ResolvedReading): CSSProperties {
  return {
    "--reader-font": resolved.fontFamily,
    "--reader-size": `${resolved.fontSizePx}px`,
    "--reader-lh": String(resolved.lineHeight),
    "--reader-measure": resolved.measure,
  } as CSSProperties;
}
