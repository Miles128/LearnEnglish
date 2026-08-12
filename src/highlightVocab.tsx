import type { MouseEvent, ReactNode } from "react";
import { createElement, Fragment } from "react";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type VocabHitHandlers = {
  onTermClick?: (term: string, event: MouseEvent<HTMLElement>) => void;
};

/**
 * Split plain text and wrap learning-vocab matches in <mark class="vocab-hit">.
 * Longer terms win first to prefer phrases over single words.
 */
export function highlightVocabText(
  text: string,
  terms: string[],
  handlers: VocabHitHandlers = {},
): ReactNode {
  const cleaned = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);

  if (cleaned.length === 0) return text;

  const pattern = new RegExp(
    `(?:${cleaned
      .map((t) => {
        const e = escapeRegExp(t);
        return /\s/.test(t) ? e : `\\b${e}\\b`;
      })
      .join("|")})`,
    "gi",
  );

  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const { onTermClick } = handlers;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const matched = match[0];
    const canonical =
      cleaned.find((t) => t.toLowerCase() === matched.toLowerCase()) ?? matched;
    parts.push(
      createElement(
        "mark",
        {
          key: `v-${key++}`,
          className: "vocab-hit",
          title: "生词库 · 点击查看",
          onClick: onTermClick
            ? (e: MouseEvent<HTMLElement>) => {
                e.preventDefault();
                e.stopPropagation();
                onTermClick(canonical, e);
              }
            : undefined,
        },
        matched,
      ),
    );
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return createElement(Fragment, null, ...parts);
}
