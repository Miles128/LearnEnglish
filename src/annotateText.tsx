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
 * Every English word is clickable. `onHardClick` must be referentially stable.
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
    span.hard ? "hard-word" : "plain-word",
    span.learning ? "vocab-hit" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const title = [
    span.hard ? "超出当前难度" : "单击翻译",
    span.learning ? "生词库 · 学习中" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const onClick = (e: MouseEvent) => {
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
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    onHardClick?.({
      term: span.term,
      display: span.text,
      zh: span.zh,
      clientX: r.left + r.width / 2,
      clientY: r.top,
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

  if (span.learning && !span.hard) {
    return createElement(
      "mark",
      { ...interactive, className: classNames },
      span.text,
    );
  }
  return createElement("span", { ...interactive, className: classNames }, span.text);
}
