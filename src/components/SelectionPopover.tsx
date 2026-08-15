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

/** Floating panel shown after selecting / clicking a word. */
export default function SelectionPopover({
  popover,
  speaking,
  speakTarget,
  onSpeakWord,
  onAddVocab,
  onClose,
}: Props) {
  return (
    <div
      className="selection-pop"
      style={{ left: popover.x, top: popover.y + 12 }}
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