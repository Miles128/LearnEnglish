export function articleListBlurb(input: {
  summary_zh: string;
  excerpt: string;
}): string {
  if (input.summary_zh) return input.summary_zh;
  if (!input.excerpt) return "";
  return `${input.excerpt.slice(0, 140)}…`;
}
