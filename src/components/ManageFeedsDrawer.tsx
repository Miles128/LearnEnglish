import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  FeedCategory,
  FeedDiscoverCandidate,
  FeedSource,
  FeedValidation,
} from "../api";

type DiscoverRow = FeedDiscoverCandidate & {
  validation?: FeedValidation;
  validating?: boolean;
  subscribed?: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function ManageFeedsDrawer({ open, onClose }: Props) {
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [feeds, setFeeds] = useState<FeedSource[]>([]);
  const [categoryId, setCategoryId] = useState("all");
  const [newCatLabel, setNewCatLabel] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<DiscoverRow[]>([]);
  const [pasteUrl, setPasteUrl] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cats, list] = await Promise.all([
        api.listFeedCategories(),
        api.listFeeds(),
      ]);
      setCategories(cats);
      setFeeds(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const filteredFeeds = useMemo(() => {
    if (categoryId === "all") return feeds;
    return feeds.filter((f) => f.category === categoryId);
  }, [feeds, categoryId]);

  const discoverCategoryId =
    categoryId === "all" ? categories[0]?.id ?? "tech" : categoryId;

  const subscribedUrls = useMemo(
    () => new Set(feeds.filter((f) => f.enabled).map((f) => f.url)),
    [feeds],
  );

  async function toggleFeed(id: string, enabled: boolean) {
    setError(null);
    try {
      await api.setFeedEnabled(id, enabled);
      setFeeds((prev) =>
        prev.map((f) => (f.id === id ? { ...f, enabled } : f)),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function onAddCategory(e: FormEvent) {
    e.preventDefault();
    const label = newCatLabel.trim();
    if (!label) return;
    setAddingCat(true);
    setError(null);
    try {
      const cat = await api.addFeedCategory(label);
      setNewCatLabel("");
      setCategories((prev) => [...prev, cat]);
      setCategoryId(cat.id);
      setMessage(`已添加分类「${cat.label}」`);
    } catch (err) {
      setError(String(err));
    } finally {
      setAddingCat(false);
    }
  }

  async function onDiscover() {
    setDiscovering(true);
    setError(null);
    setMessage(null);
    setCandidates([]);
    try {
      const list = await api.discoverFeeds(discoverCategoryId);
      const rows: DiscoverRow[] = list.map((c) => ({
        ...c,
        subscribed: subscribedUrls.has(c.url.trim()),
      }));
      setCandidates(rows);
      setMessage(`找到 ${rows.length} 个候选，正在校验…`);
      // validate sequentially to avoid hammering
      for (let i = 0; i < rows.length; i++) {
        setCandidates((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, validating: true } : r)),
        );
        try {
          const validation = await api.validateFeed(rows[i].url);
          setCandidates((prev) =>
            prev.map((r, idx) =>
              idx === i ? { ...r, validating: false, validation } : r,
            ),
          );
        } catch (err) {
          setCandidates((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    validating: false,
                    validation: {
                      ok: false,
                      title: null,
                      entry_count: 0,
                      error: String(err),
                    },
                  }
                : r,
            ),
          );
        }
      }
      setMessage("校验完成，可订阅可用源");
    } catch (e) {
      setError(String(e));
    } finally {
      setDiscovering(false);
    }
  }

  async function onSubscribeCandidate(row: DiscoverRow) {
    setError(null);
    try {
      if (!row.validation?.ok) {
        const v = await api.validateFeed(row.url);
        if (!v.ok) {
          setError(v.error ?? "该源无法校验");
          return;
        }
      }
      await api.subscribeFeed({
        name: row.name,
        category: discoverCategoryId,
        url: row.url,
        description: row.description,
      });
      setCandidates((prev) =>
        prev.map((c) =>
          c.url === row.url ? { ...c, subscribed: true } : c,
        ),
      );
      await load();
      setMessage(`已订阅：${row.name}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onPasteSubscribe(e: FormEvent) {
    e.preventDefault();
    const url = pasteUrl.trim();
    if (!url) return;
    setPasting(true);
    setError(null);
    try {
      const v = await api.validateFeed(url);
      if (!v.ok) {
        setError(v.error ?? "RSS 校验失败");
        return;
      }
      const name =
        pasteName.trim() || v.title?.trim() || url.replace(/^https?:\/\//, "");
      await api.subscribeFeed({
        name,
        category: discoverCategoryId,
        url,
        description: "",
      });
      setPasteUrl("");
      setPasteName("");
      await load();
      setMessage(`已订阅：${name}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setPasting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="feeds-drawer-root" role="dialog" aria-modal="true">
      <button
        type="button"
        className="feeds-drawer-backdrop"
        aria-label="关闭"
        onClick={onClose}
      />
      <aside className="feeds-drawer">
        <header className="feeds-drawer-head">
          <div>
            <h2>管理订阅</h2>
            <p className="muted">开关订阅 · 按分类发现 · 自建分类</p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        {message && <p className="banner ok">{message}</p>}
        {error && <p className="banner err">{error}</p>}

        <div className="feeds-cat-row">
          <button
            type="button"
            className={categoryId === "all" ? "tab active" : "tab"}
            onClick={() => setCategoryId("all")}
          >
            全部
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={categoryId === c.id ? "tab active" : "tab"}
              onClick={() => setCategoryId(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <form className="feeds-add-cat" onSubmit={(e) => void onAddCategory(e)}>
          <input
            value={newCatLabel}
            onChange={(e) => setNewCatLabel(e.target.value)}
            placeholder="新建分类名…"
            disabled={addingCat}
          />
          <button className="btn" type="submit" disabled={addingCat || !newCatLabel.trim()}>
            {addingCat ? "添加中…" : "+ 分类"}
          </button>
        </form>

        <section className="feeds-drawer-section">
          <h3>我的订阅</h3>
          <ul className="feed-list">
            {filteredFeeds.length === 0 && (
              <li className="muted">该分类下暂无订阅</li>
            )}
            {filteredFeeds.map((f) => (
              <li key={f.id}>
                <label className="feed-row">
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={(e) => void toggleFeed(f.id, e.target.checked)}
                  />
                  <span className="feed-row-main">
                    <strong>{f.name}</strong>
                    <span className="muted">
                      {" "}
                      · {f.origin === "user" ? "自订" : "精选"}
                      {f.description ? ` · ${f.description}` : ""}
                    </span>
                    <span className="feed-url muted">{f.url}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="feeds-drawer-section">
          <div className="feeds-section-head">
            <h3>
              按分类发现
              <span className="muted">
                {" "}
                ·{" "}
                {categories.find((c) => c.id === discoverCategoryId)?.label ??
                  discoverCategoryId}
              </span>
            </h3>
            <button
              type="button"
              className="btn primary"
              onClick={() => void onDiscover()}
              disabled={discovering}
            >
              {discovering ? "搜索中…" : "用 AI 搜索推荐源"}
            </button>
          </div>
          <ul className="discover-list">
            {candidates.map((c) => {
              const ok = c.validation?.ok;
              const status = c.validating
                ? "校验中…"
                : c.validation
                  ? ok
                    ? `可用 · ${c.validation.entry_count} 条`
                    : c.validation.error ?? "不可用"
                  : "待校验";
              return (
                <li key={c.url} className="discover-row">
                  <div>
                    <strong>{c.name}</strong>
                    {c.description ? (
                      <p className="muted discover-desc">{c.description}</p>
                    ) : null}
                    <p className="feed-url muted">{c.url}</p>
                    <p className={ok ? "muted" : "banner err inline-status"}>
                      {status}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={c.subscribed || c.validating || ok === false}
                    onClick={() => void onSubscribeCandidate(c)}
                  >
                    {c.subscribed ? "已订阅" : "订阅"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="feeds-drawer-section">
          <h3>粘贴 RSS 订阅</h3>
          <form
            className="feeds-paste"
            onSubmit={(e) => void onPasteSubscribe(e)}
          >
            <input
              value={pasteName}
              onChange={(e) => setPasteName(e.target.value)}
              placeholder="名称（可选）"
              disabled={pasting}
            />
            <input
              value={pasteUrl}
              onChange={(e) => setPasteUrl(e.target.value)}
              placeholder="https://…/rss.xml"
              disabled={pasting}
            />
            <button
              className="btn primary"
              type="submit"
              disabled={pasting || !pasteUrl.trim()}
            >
              {pasting ? "订阅中…" : "订阅"}
            </button>
          </form>
        </section>
      </aside>
    </div>
  );
}
