export function articleListBlurb(input: {
  summary_zh: string;
  excerpt?: string;
}): string {
  return input.summary_zh.trim();
}

export function articleNeedsCardZh(input: {
  title_zh: string;
  summary_zh: string;
}): boolean {
  return !input.title_zh.trim() || !input.summary_zh.trim();
}
