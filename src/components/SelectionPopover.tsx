import { useLayoutEffect, useRef, useState } from "react";
import type { SpeakTarget } from "../useTts";
import type { WordDetail } from "../wordResolve";

export type Popover = {
  x: number;
  y: number;
  text: string;
  /** Raw selection (before lemma reduction) — used for context sentences. */
  source?: string;
  /** Rich local dictionary entry (senses, phonetics, examples). */
  detail?: WordDetail | null;
  /** Where the shown translation came from, for transparency. */
  origin?: "local" | "ai";
  translation?: string;
  loading?: boolean;
  error?: string;
};

type Props = {
  popover: Popover;
  speaking: boolean;
  speakTarget: SpeakTarget | null;
  onSpeakWord: (text: string) => void;
  onAddVocab: () => void;
  /** Present for multi-word selections: save into the phrase library. */
  onAddPhrase?: () => void;
  /** Present for single words: mark/unmark as already known. */
  onToggleKnown?: () => void;
  known?: boolean;
  onClose: () => void;
};

export function clampPopoverPosition(input: {
  x: number;
  y: number;
  viewW: number;
  viewH: number;
  popW?: number;
  popH?: number;
  gap?: number;
  margin?: number;
  shiftX?: number;
}): { x: number; y: number } {
  const popW = input.popW ?? 280;
  const popH = input.popH ?? 160;
  const gap = input.gap ?? 12;
  const margin = input.margin ?? 8;
  const shiftX = input.shiftX ?? 0.3;

  let left = input.x - popW * shiftX;
  let top = input.y + gap;
  const maxLeft = input.viewW - margin - popW;
  left = Math.min(Math.max(left, margin), Math.max(margin, maxLeft));
  if (top + popH > input.viewH - margin) {
    top = input.y - gap - popH;
  }
  const maxTop = input.viewH - margin - popH;
  top = Math.min(Math.max(top, margin), Math.max(margin, maxTop));
  return { x: left + popW * shiftX, y: top - gap };
}

/** Split a stored POS string ("v./n.") for display. */
export function posLabel(pos: string): string {
  return pos
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" · ");
}

/** Floating panel shown after selecting / clicking a word. */
export default function SelectionPopover({
  popover,
  speaking,
  speakTarget,
  onSpeakWord,
  onAddVocab,
  onAddPhrase,
  onToggleKnown,
  known,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 280, h: 160 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setBox((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1
        ? prev
        : { w: width, h: height },
    );
  }, [popover.text, popover.translation, popover.loading, popover.error]);
  const pos = clampPopoverPosition({
    x: popover.x,
    y: popover.y,
    viewW: typeof window === "undefined" ? 800 : window.innerWidth,
    viewH: typeof window === "undefined" ? 600 : window.innerHeight,
    popW: box.w,
    popH: box.h,
  });
  return (
    <div
      ref={ref}
      className="selection-pop"
      role="dialog"
      aria-modal="true"
      aria-label={popover.text}
      style={{ left: pos.x, top: pos.y + 12 }}
    >
      <div className="pop-term">
        {popover.text}
        {popover.detail?.phonetic ? (
          <span className="pop-phonetic">/ {popover.detail.phonetic} /</span>
        ) : null}
        {popover.detail?.pos ? (
          <span className="pop-pos">{posLabel(popover.detail.pos)}</span>
        ) : null}
      </div>
      {popover.loading && <div className="muted">翻译中…</div>}
      {popover.error && <div className="err-inline">{popover.error}</div>}

      {popover.detail && popover.detail.senses.length > 0 ? (
        <ol className="pop-senses">
          {popover.detail.senses.slice(0, 4).map((sense, i) => (
            <li key={i}>{sense}</li>
          ))}
        </ol>
      ) : popover.translation ? (
        <div className="pop-zh">{popover.translation}</div>
      ) : null}

      {popover.detail && popover.detail.examples.length > 0 && (
        <div className="pop-examples">
          {popover.detail.examples.map((ex, i) => (
            <div className="pop-example" key={i}>
              <p className="pop-ex-en">{ex.en}</p>
              {ex.zh ? <p className="pop-ex-zh">{ex.zh}</p> : null}
            </div>
          ))}
        </div>
      )}

      {popover.origin === "local" && (
        <div className="pop-origin muted">内置词典 · ECDICT / Tatoeba</div>
      )}
      {popover.origin === "ai" && <div className="pop-origin muted">AI 翻译</div>}
      <div className="pop-actions">
        <button
          className="btn small"
          type="button"
          onClick={() => onSpeakWord(popover.text)}
        >
          {speaking && speakTarget?.kind === "word" ? "停止" : "朗读"}
        </button>
        {onAddPhrase ? (
          <button className="btn small primary" onClick={onAddPhrase}>
            加入短语组合
          </button>
        ) : null}
        <button
          className={onAddPhrase ? "btn small" : "btn small primary"}
          onClick={onAddVocab}
        >
          加入生词库
        </button>
        {onToggleKnown ? (
          <button className="btn small" onClick={onToggleKnown}>
            {known ? "取消已知" : "标记已知"}
          </button>
        ) : null}
        <button className="btn small" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}