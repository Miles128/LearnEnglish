/** Detect Markdown from URL extension and/or content heuristics. */

const MD_EXT = /\.(md|markdown)(?:$|[?#])/i;

const HEURISTICS: RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX headings
  /^(\s{0,3}[-*+]|\s{0,3}\d+\.)\s+\S/m, // lists
  /^```/m, // fenced code
  /\[[^\]]+\]\([^)]+\)/, // links
  /(\*\*|__).+?\1/, // bold
  /(?:^|[^*])\*[^*\n]+\*(?:[^*]|$)/, // italic *...*
];

export function urlLooksLikeMarkdown(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return MD_EXT.test(path);
  } catch {
    return MD_EXT.test(url);
  }
}

/** True if at least two distinct Markdown signals appear in the text. */
export function contentLooksLikeMarkdown(text: string): boolean {
  let hits = 0;
  for (const re of HEURISTICS) {
    if (re.test(text)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  // Strong single signals: fenced code or multiple headings
  if (/^```/m.test(text)) return true;
  const headings = text.match(/^#{1,6}\s+\S/gm);
  if (headings && headings.length >= 2) return true;
  return false;
}

export function shouldRenderMarkdown(url: string, content: string): boolean {
  return urlLooksLikeMarkdown(url) || contentLooksLikeMarkdown(content);
}
