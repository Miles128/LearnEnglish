import { useLayoutEffect, useRef, useState } from "react";
import type { SpeakTarget } from "../useTts";

export type Popover = {
  x: number;
  y: number;
  text: string;
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

/** Floating panel shown after selecting / clicking a word. */
export default function SelectionPopover({
  popover,
  speaking,
  speakTarget,
  onSpeakWord,
  onAddVocab,
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
      <div className="pop-term">{popover.text}</div>
      {popover.loading && <div className="muted">翻译中…</div>}
      {popover.error && <div className="err-inline">{popover.error}</div>}
      {popover.translation && <div className="pop-zh">{popover.translation}</div>}
      <div className="pop-actions">
        <button
          className="btn small"
          type="button"
          onClick={() => onSpeakWord(popover.text)}
        >
          {speaking && speakTarget?.kind === "word" ? "停止" : "朗读"}
        </button>
        <button className="btn small primary" onClick={onAddVocab}>
          加入生词库
        </button>
        <button className="btn small" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}