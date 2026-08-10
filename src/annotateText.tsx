import {
  createElement,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  annotateText,
  type DifficultyPrefs,
  type AnnotatedSpan,
} from "./wordLevels";

export type HardWordClick = (info: {
  term: string;
  display: string;
  zh?: string;
  clientX: number;
  clientY: number;
}) => void;

/**
 * Render paragraph text with difficulty underlines + learning-vocab marks.
 */
export function renderAnnotatedParagraph(
  text: string,
  prefs: DifficultyPrefs,
  learningTerms: string[],
  onHardClick?: HardWordClick,
): ReactNode {
  const spans = annotateText(text, prefs, learningTerms);
  return createElement(
    Fragment,
    null,
    ...spans.map((s, i) => renderSpan(s, i, onHardClick)),
  );
}

function renderSpan(
  span: AnnotatedSpan,
  key: number,
  onHardClick?: HardWordClick,
): ReactNode {
  if (span.type === "text") return span.text;

  const classNames = [
    span.hard ? "hard-word" : null,
    span.learning ? "vocab-hit" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const title = [
    span.hard ? "超出当前难度" : null,
    span.learning ? "生词库 · 学习中" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const onClick = (e: MouseEvent) => {
    if (!span.hard && !span.learning) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();
    onHardClick?.({
      term: span.term,
      display: span.text,
      zh: span.zh,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  // Hard words: clickable underline span. Learning-only: mark.
  if (span.hard) {
    return createElement(
      "span",
      {
        key: `t-${key}`,
        className: classNames,
        title,
        role: "button",
        tabIndex: 0,
        onClick,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onHardClick?.({
              term: span.term,
              display: span.text,
              zh: span.zh,
              clientX: 0,
              clientY: 0,
            });
          }
        },
      },
      span.text,
    );
  }

  return createElement(
    "mark",
    {
      key: `t-${key}`,
      className: classNames || "vocab-hit",
      title,
      onClick,
    },
    span.text,
  );
}
