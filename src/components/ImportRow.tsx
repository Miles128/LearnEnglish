import type { FormEvent } from "react";

type Props = {
  importing: boolean;
  importUrl: string;
  onImportUrlChange: (url: string) => void;
  onImport: (e: FormEvent) => void;
  onImportFile: () => void;
};

/** URL/file import form on the Home header. */
export default function ImportRow({
  importing,
  importUrl,
  onImportUrlChange,
  onImport,
  onImportFile,
}: Props) {
  return (
    <form className="import-row" onSubmit={onImport}>
      <input
        className="import-input"
        type="url"
        placeholder="粘贴公开文章链接导入…"
        value={importUrl}
        onChange={(e) => onImportUrlChange(e.target.value)}
        disabled={importing}
      />
      <button className="btn" type="submit" disabled={importing || !importUrl.trim()}>
        {importing ? "导入中…" : "导入"}
      </button>
      <button
        className="btn"
        type="button"
        disabled={importing}
        onClick={onImportFile}
      >
        导入文件
      </button>
    </form>
  );
}