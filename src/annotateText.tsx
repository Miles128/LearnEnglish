import {
  createElement,
  Fragment,
  memo,
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
 * Memoized per-paragraph annotation so only paragraphs whose text, prefs or
 * vocab changed re-run the (expensive) word-level annotation pass.
 * `onHardClick` must be referentially stable (useCallback) to get memo hits.
 */
export const AnnotatedPara = memo(function AnnotatedPara({
  text,
  prefs,
  learningTerms,
  onHardClick,
}: {
  text: string;
  prefs: DifficultyPrefs;
  learningTerms: string[];
  onHardClick?: HardWordClick;
}): ReactNode {
  return createElement(
    Fragment,
    null,
    ...annotateText(text, prefs, learningTerms).map((s, i) =>
      renderSpan(s, i, onHardClick),
    ),
  );
});

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

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onHardClick?.({
      term: span.term,
      display: span.text,
      zh: span.zh,
      clientX: 0,
      clientY: 0,
    });
  };

  const interactive = {
    key: `t-${key}`,
    title,
    role: "button" as const,
    tabIndex: 0,
    onClick,
    onKeyDown,
  };

  if (span.hard) {
    return createElement("span", { ...interactive, className: classNames }, span.text);
  }
  return createElement(
    "mark",
    { ...interactive, className: classNames || "vocab-hit" },
    span.text,
  );
}
