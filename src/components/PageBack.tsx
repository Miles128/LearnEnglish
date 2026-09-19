import { useNavigate } from "react-router-dom";

/**
 * Borderless back-to-home icon button.
 * Sits at the right edge of a page's first row (page-header) — never on its own row.
 */
export default function PageBack() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => navigate("/")}
      title="返回主界面"
      aria-label="返回主界面"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M19 12H5" />
        <path d="m12 19-7-7 7-7" />
      </svg>
    </button>
  );
}
