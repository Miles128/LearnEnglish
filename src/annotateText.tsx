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
 * `showGloss` reveals a small Chinese annotation under super-hard words; the
 * click-through behaviour is unchanged (still opens the LLM-context popover).
 */
export const AnnotatedPara = memo(function AnnotatedPara({
  text,
  prefs,
  learningTerms,
  knownTerms,
  onHardClick,
  showGloss = false,
}: {
  text: string;
  prefs: DifficultyPrefs;
  learningTerms: string[];
  knownTerms?: string[];
  onHardClick?: HardWordClick;
  showGloss?: boolean;
}): ReactNode {
  return createElement(
    Fragment,
    null,
    ...annotateText(text, prefs, learningTerms, knownTerms).map((s, i) =>
      renderSpan(s, i, onHardClick, showGloss),
    ),
  );
});

function renderSpan(
  span: AnnotatedSpan,
  key: number,
  onHardClick?: HardWordClick,
  showGloss = false,
): ReactNode {
  if (span.type === "text") return span.text;

  const classNames = [
    span.hard ? "hard-word" : "plain-word",
    span.learning ? "vocab-hit" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const accessibleName = [
    span.hard ? "超出当前难度，单击翻译" : "单击翻译",
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

  // 用 aria-label 而非 title：原生 tooltip 在鼠标扫过时反复弹出，是阅读区行抖动的来源之一。
  const interactive = {
    key: `t-${key}`,
    "aria-label": accessibleName,
    role: "button" as const,
    onClick,
    onKeyDown,
  };

  const wordEl =
    span.learning && !span.hard
      ? createElement(
          "mark",
          { ...interactive, className: classNames },
          span.text,
        )
      : createElement(
          "span",
          { ...interactive, className: classNames },
          span.text,
        );

  // 仅对「超级难词 + 词典里有中文首义 + 用户开了开关」挂淡色小字；hover 时 CSS 提升可读性。
  // 点词/键盘 Enter 仍走原 LLM 上下文翻译路径，不受这里影响。
  if (showGloss && span.superHard && span.hard && span.zh) {
    return createElement(
      "span",
      { key: `g-${key}`, className: "gloss-wrap" },
      wordEl,
      createElement(
        "span",
        { className: "word-gloss", "aria-hidden": true },
        span.zh,
      ),
    );
  }
  return wordEl;
}
