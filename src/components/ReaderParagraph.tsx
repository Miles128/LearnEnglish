import type { ReactNode } from "react";
import Markdown from "react-markdown";

type Props = {
  text: string;
  asMarkdown: boolean;
  annotateChildren: (children: ReactNode) => ReactNode;
  zhVisible: boolean;
  zhText?: string;
  translating: boolean;
  visiblePara: boolean;
  paraSpeaking: boolean;
  onTranslate: () => void;
  onSpeak: () => void;
};

export default function ReaderParagraph({
  text,
  asMarkdown,
  annotateChildren,
  zhVisible,
  zhText,
  translating,
  visiblePara,
  paraSpeaking,
  onTranslate,
  onSpeak,
}: Props) {
  return (
    <div className="para-block">
      <div className="para-gutter">
        <button
          className="para-btn"
          type="button"
          title="翻译本段"
          onClick={onTranslate}
          disabled={translating}
        >
          {translating ? "…" : visiblePara ? "隐" : "译"}
        </button>
        <button
          className={`para-btn${paraSpeaking ? " active" : ""}`}
          type="button"
          title={paraSpeaking ? "停止朗读" : "朗读本段"}
          onClick={onSpeak}
        >
          {paraSpeaking ? "停" : "读"}
        </button>
      </div>
      <div className="para-content">
        {asMarkdown ? (
          <div className="md-preview">
            <Markdown
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
                p: ({ children }) => <p>{annotateChildren(children)}</p>,
              }}
            >
              {text}
            </Markdown>
          </div>
        ) : (
          <p>{annotateChildren(text)}</p>
        )}
        {zhVisible && zhText && <p className="zh">{zhText}</p>}
      </div>
    </div>
  );
}
