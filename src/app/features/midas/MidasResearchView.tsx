"use client";

import { ArrowClockwise, CaretLeft, CaretRight, CheckCircle, Lightbulb, MagnifyingGlass, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, type Locale } from "../../platform/i18n";
import { visibleMidasIdeas, type MidasIdea, type MidasIdeasResponse, type MidasResearchViewId } from "./research-contracts";
import { DataAccessView } from "../data/DataAccessView";

const RESEARCH_COPY = {
  en: { ideas: "Ideas", ideasDescription: "Explore registered investment ideas.", readOnly: "Read-only · Legacy ideas", loading: "Loading ideas…", unavailable: "Ideas are unavailable.", retry: "Retry", all: "All", details: "Details" },
  ja: { ideas: "アイデア", ideasDescription: "登録済みの投資アイデアを確認します。", readOnly: "読み取り専用 · 既存アイデア", loading: "アイデアを読み込み中…", unavailable: "アイデアを取得できませんでした。", retry: "再試行", all: "すべて", details: "詳細" },
};

type Loadable<T> = Readonly<{
  data: T | null;
  status: "loading" | "ready" | "error";
  retry: () => void;
}>;

function useMidasResource<T>(url: string): Loadable<T> {
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) setStatus("loading");
    });
    void fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Midas request failed (${response.status})`);
        return response.json() as Promise<T>;
      })
      .then((payload) => {
        if (payload && typeof payload === "object") {
          const availability = payload as { available?: unknown; ok?: unknown };
          if (("available" in availability && availability.available !== true)
            || ("ok" in availability && availability.ok !== true)) {
            throw new Error("Midas research payload is unavailable");
          }
        }
        setData(payload);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
      });
    return () => controller.abort();
  }, [nonce, url]);

  return {
    data,
    status,
    retry: useCallback(() => setNonce((value) => value + 1), []),
  };
}

function compactNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function uniqueSorted(values: readonly (string | null | undefined)[]) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))))
    .sort((left, right) => left.localeCompare(right, "ja"));
}

function toneClass(tone: string | undefined) {
  if (tone === "positive" || tone === "ok" || tone === "ready") return "is-positive";
  if (tone === "negative" || tone === "failed" || tone === "error") return "is-negative";
  if (tone === "warn" || tone === "stale") return "is-warning";
  return "is-neutral";
}

function useSelectionPanelFocus<T>(selected: T | null) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  return panelRef;
}

function ResearchShell({
  title,
  description,
  icon,
  meta,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const { locale } = useI18n();
  const copy = RESEARCH_COPY[locale];
  return (
    <section className="midas-research-shell">
      <div className="midas-research-scroll">
        <header className="midas-page-header">
          <div className="midas-page-title">
            <span className="midas-page-icon">{icon}</span>
            <div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </div>
          {meta && <div className="midas-page-meta">{meta}</div>}
        </header>
        {children}
      </div>
      <footer className="midas-status-bar">
        <span><CheckCircle size={13} /> {copy.readOnly}</span>
        <span>UTC+9</span>
      </footer>
    </section>
  );
}

function ResourceState({
  status,
  retry,
  children,
}: {
  status: Loadable<unknown>["status"];
  retry: () => void;
  children: ReactNode;
}) {
  const { locale } = useI18n();
  const copy = RESEARCH_COPY[locale];
  if (status === "loading") {
    return <div className="midas-resource-state" role="status"><ArrowClockwise className="is-spinning" size={20} /> {copy.loading}</div>;
  }
  if (status === "error") {
    return (
      <div className="midas-resource-state is-error" role="alert">
        <WarningCircle size={20} />
        <span>{copy.unavailable}</span>
        <button type="button" onClick={retry}><ArrowClockwise size={15} /> {copy.retry}</button>
      </div>
    );
  }
  return children;
}

function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const { locale } = useI18n();
  return (
    <div className="midas-pagination" aria-label={locale === "ja" ? "ページ移動" : "Pagination"}>
      <span>{compactNumber(total, locale)}{locale === "ja" ? "件" : " results"}</span>
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={locale === "ja" ? "前へ" : "Previous page"}><CaretLeft size={15} /></button>
      <strong>{page} / {Math.max(1, totalPages)}</strong>
      <button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)} aria-label={locale === "ja" ? "次へ" : "Next page"}><CaretRight size={15} /></button>
    </div>
  );
}

function ideaFeasibilityLabel(value: string | undefined, locale: Locale) {
  if (value === "buildable_now") return locale === "ja" ? "今すぐ作れる" : "Buildable now";
  if (value === "research_only") return locale === "ja" ? "研究のみ" : "Research only";
  if (value === "engine_required") return locale === "ja" ? "エンジン要" : "Engine required";
  if (value === "data_pending") return locale === "ja" ? "データ待ち" : "Waiting for data";
  return value ?? "—";
}

function IdeasView() {
  const { locale } = useI18n();
  const copy = RESEARCH_COPY[locale];
  const resource = useMidasResource<MidasIdeasResponse>("/api/v1/midas/ideas");
  const ideas = useMemo(() => visibleMidasIdeas(resource.data?.ideas ?? []), [resource.data]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [dataNeed, setDataNeed] = useState("");
  const [feasibility, setFeasibility] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MidasIdea | null>(null);
  const selectionPanelRef = useSelectionPanelFocus(selected);
  const categories = useMemo(() => uniqueSorted(ideas.map((idea) => idea.category)), [ideas]);
  const subcategories = useMemo(() => category
    ? uniqueSorted(ideas.filter((idea) => idea.category === category).map((idea) => idea.subcategory))
    : [], [category, ideas]);
  const dataNeeds = useMemo(() => uniqueSorted(ideas.flatMap((idea) => idea.data_needs)), [ideas]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return ideas.filter((idea) => (!needle || `${idea.name} ${idea.id} ${idea.category} ${idea.subcategory}`.toLocaleLowerCase().includes(needle))
      && (!category || idea.category === category)
      && (!subcategory || idea.subcategory === subcategory)
      && (!dataNeed || idea.data_needs.includes(dataNeed))
      && (!feasibility || idea.buildable_spec?.feasibility === feasibility));
  }, [category, dataNeed, feasibility, ideas, search, subcategory]);
  const pageSize = 30;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const resetPage = () => {
    setPage(1);
    setSelected(null);
  };

  return (
    <ResearchShell title={copy.ideas} description={copy.ideasDescription} icon={<Lightbulb size={20} />} meta={resource.data ? <><strong>{compactNumber(ideas.length, locale)}</strong><span>{locale === "ja" ? "件" : "ideas"}</span></> : undefined}>
      <div className="midas-filter-bar catalog-filters">
        <label className="midas-search-field"><MagnifyingGlass size={15} /><input value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} placeholder={locale === "ja" ? "アイデア名・ID・分類" : "Idea name, ID, or category"} aria-label={locale === "ja" ? "アイデアを検索" : "Search ideas"} /></label>
        <label><span>{locale === "ja" ? "大分類" : "Category"}</span><select value={category} onChange={(event) => { setCategory(event.target.value); setSubcategory(""); resetPage(); }}><option value="">{copy.all}</option>{categories.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>{locale === "ja" ? "小分類" : "Subcategory"}</span><select value={subcategory} disabled={!category} onChange={(event) => { setSubcategory(event.target.value); resetPage(); }}><option value="">{category ? copy.all : (locale === "ja" ? "先に大分類を選択" : "Choose a category first")}</option>{subcategories.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>{locale === "ja" ? "必要データ" : "Data need"}</span><select value={dataNeed} onChange={(event) => { setDataNeed(event.target.value); resetPage(); }}><option value="">{copy.all}</option>{dataNeeds.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>{locale === "ja" ? "実現可否" : "Feasibility"}</span><select value={feasibility} onChange={(event) => { setFeasibility(event.target.value); resetPage(); }}><option value="">{copy.all}</option><option value="buildable_now">{ideaFeasibilityLabel("buildable_now", locale)}</option><option value="research_only">{ideaFeasibilityLabel("research_only", locale)}</option></select></label>
      </div>
      <ResourceState status={resource.status} retry={resource.retry}>
        <Pagination page={safePage} totalPages={totalPages} total={filtered.length} onChange={(nextPage) => { setSelected(null); setPage(nextPage); }} />
        <div className="midas-table-shell ideas-table-shell">
          <table className="midas-data-table ideas-table">
            <thead><tr><th>{locale === "ja" ? "大分類" : "Category"}</th><th>{locale === "ja" ? "小分類" : "Subcategory"}</th><th>{locale === "ja" ? "アイデア" : "Idea"}</th><th>{locale === "ja" ? "必要データ" : "Data"}</th><th>{locale === "ja" ? "実現可否" : "Feasibility"}</th><th /></tr></thead>
            <tbody>{pageItems.map((idea) => <tr key={idea.id} className={selected?.id === idea.id ? "is-selected" : ""}><td><span className="midas-category-pill">{idea.category}</span></td><td>{idea.subcategory}</td><td><div className="midas-primary-cell"><strong>{idea.name}</strong><span>{idea.id}</span></div></td><td><div className="midas-tag-list">{idea.data_needs.map((value) => <i key={value}>{value}</i>)}</div></td><td><span className={`midas-state-pill ${toneClass(idea.buildable_spec?.feasibility === "buildable_now" ? "positive" : "neutral")}`}>{ideaFeasibilityLabel(idea.buildable_spec?.feasibility, locale)}</span></td><td><button type="button" className="midas-row-action" onClick={() => setSelected((current) => current?.id === idea.id ? null : idea)} aria-label={`${copy.details}: ${idea.name}`} aria-expanded={selected?.id === idea.id} aria-controls="idea-detail-panel"><CaretRight size={15} /></button></td></tr>)}</tbody>
          </table>
          {pageItems.length === 0 && <div className="midas-empty-state">{locale === "ja" ? "条件に合うアイデアがありません。" : "No ideas match these filters."}</div>}
        </div>
        {selected && <aside ref={selectionPanelRef} id="idea-detail-panel" className="midas-selection-panel" tabIndex={-1}><div><span>{selected.category} · {selected.subcategory}</span><h2>{selected.name}</h2><p>{selected.id}</p></div><dl><div><dt>{locale === "ja" ? "必要データ" : "Required data"}</dt><dd>{selected.data_needs.join(" · ") || "—"}</dd></div><div><dt>{locale === "ja" ? "実現可否" : "Feasibility"}</dt><dd>{ideaFeasibilityLabel(selected.buildable_spec?.feasibility, locale)}</dd></div><div><dt>{locale === "ja" ? "実装状況" : "Status"}</dt><dd>{selected.status === "implemented" ? (locale === "ja" ? "実装済み" : "Implemented") : selected.status}</dd></div></dl><button type="button" onClick={() => setSelected(null)} aria-label={locale === "ja" ? "詳細を閉じる" : "Close details"}><XCircle size={18} /></button></aside>}
      </ResourceState>
    </ResearchShell>
  );
}

export function MidasResearchView({ view, onOpenChart }: {
  view: MidasResearchViewId;
  onOpenChart: (symbol: string) => void;
}) {
  if (view === "ideas") return <IdeasView />;
  const scope = view === "institutional" ? "institutional" : view === "x-analysis" ? "x" : "all";
  return <DataAccessView key={scope} scope={scope} onOpenChart={onOpenChart} />;
}
