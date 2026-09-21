"use client";

/*
 * ⚠️ VENDORED PATCH（YuanMy）：
 *   · `live`    —— 行立刻全出来（上游按 700ms 一条演示浮现，真实会话里数据已经在了）；
 *   · `compact` —— 去掉 220px 的演示最小高度（消息流里会撑出空白）；
 *   · 没有 diff 时不再渲染「文件 diff 页脚 + `+N more`」那一块；
 *   · 行 key 用下标（真实数据里同一次 run 可能连续调同一个工具，label 会重复），
 *     展开状态也改成**按下标**记 —— 上游按 label 记，两次 bash 会一起展开；
 *   · `preview` —— 行尾一行灰字（工具输出的首行）。折叠时就看这一行，
 *     点开才给全文：一次 `npm run build` 的输出是几十行，全铺在消息流里没法看；
 *   · 明细**不再 `truncate`**：按原文换行（`whitespace-pre-wrap break-words`）、
 *     超长自己滚（`max-h-[320px] overflow-y-auto`）。上游是「一行一条 + 省略号」，
 *     真实输出一多就全是省略号，等于没给（用户报的「展示残缺」就是这个）；
 *   · 明细内容**首次展开才挂载**（`everOpen`）：一次 run 里十几个工具、每个几十 KB，
 *     全量挂进 DOM 会拖慢消息流。
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const STEP_MS = 700;

const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></g>,
  run: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></g>,
  read: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
};

export type ToolDetailLine = { text: string; tone?: "add" };

export type ToolStep = {
  icon: string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
  /** VENDORED PATCH：行尾的一行预览（工具输出的首行，折叠时就看它）。 */
  preview?: string;
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  more: string;
};

const DEFAULT_LABELS: ToolChipsLabels = {
  header: "4 tool calls, 2 messages",
  more: "+2 more",
};

const ROWS: ToolStep[] = [
  {
    icon: "think", label: "Thinking", chip: "Planning the churn schedule…", mono: false, detailMono: false,
    detail: [
      { text: "Weekend demand carries pistachio, so it churns first." },
      { text: "Batch capacity leaves two evening freezer windows." },
    ],
  },
  {
    icon: "write", label: "Write 204 lines", chip: "ChurnSchedule.tsx", mono: true, detailMono: true,
    detail: [
      { text: "+ const windows = slots.filter((s) => s.temp <= -12)", tone: "add" },
      { text: "+ return schedule(windows, { hero: \"pistachio\" })", tone: "add" },
    ],
  },
  {
    icon: "run", label: "Rebuild and verify", chip: "npm run freeze", mono: true, detailMono: true,
    detail: [
      { text: "✓ built in 1.2s" },
      { text: "✓ 34 checks passed" },
    ],
  },
  {
    icon: "read", label: "Read image", chip: "flavor-chart.png", mono: true, detailMono: false,
    detail: [
      { text: "1280 × 720 · line chart, three summers." },
      { text: "Mint chip trends up 12% through July." },
    ],
  },
];

const DIFFS: ToolDiff[] = [
  { file: "flavors.css", add: 13, del: 0 },
  { file: "ChurnSchedule.tsx", add: 74, del: 41 },
  { file: "menu.ts", add: 8, del: 2 },
];

/* hovering a file chip opens its diff — green added, red removed */
const DIFF_LINES: Record<string, ToolDiffLine[]> = {
  "flavors.css": [
    { text: ".scoop-card {", tone: "ctx" },
    { text: "  gap: 14px;", tone: "del" },
    { text: "  gap: 12px;", tone: "add" },
    { text: "  container-type: inline-size;", tone: "add" },
    { text: "}", tone: "ctx" },
  ],
  "ChurnSchedule.tsx": [
    { text: "const slots = coldSlots(week);", tone: "ctx" },
    { text: "const windows = slots;", tone: "del" },
    { text: "const windows = slots.filter(", tone: "add" },
    { text: "  (s) => s.temp <= -12,", tone: "add" },
    { text: ");", tone: "add" },
  ],
  "menu.ts": [
    { text: "export const hero = \"mint-chip\";", tone: "del" },
    { text: "export const hero = \"pistachio\";", tone: "add" },
  ],
};

export default function ToolChips({
  steps = ROWS,
  diffs = DIFFS,
  diffLines = DIFF_LINES,
  labels,
  className,
  onOpenChange,
  onToggleRow,
  onChipActivate,
  live = false,
  compact = false,
}: {
  /** Accepted for gallery/registry parity; ToolChips has no visual variants. */
  variant?: string;
  steps?: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels?: Partial<ToolChipsLabels>;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onToggleRow?: (label: string, open: boolean) => void;
  /** VENDORED PATCH：立刻显示全部行（不做演示时序） */
  live?: boolean;
  /** VENDORED PATCH：紧凑模式（去掉演示用的最小高度与页脚留白） */
  compact?: boolean;
  /**
   * VENDORED PATCH：点 chip 时的动作。
   *
   * 上游把 chip 做成行按钮里的一个 span（点了就是展开/收起明细）。
   * 真实界面里 chip 是「这次调用动了哪个文件/跑了哪条命令」，点它应该能**直接打开**，
   * 所以我们把行拆成「箭头+名字（可点，展开明细）」与「chip（可点，触发这个回调）」两块。
   */
  onChipActivate?: (index: number, row: ToolStep) => void;
} = {}) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(true);
  /* VENDORED PATCH：展开状态按下标记（同一次 run 里两次 bash 的 label 一样，
     按 label 记会一点开全开）；`everOpen` 记「展开过一次」的行，明细首次展开才挂载。 */
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());
  const [everOpen, setEverOpen] = useState<Set<number>>(new Set());
  /* Rendered in a body portal so animated/translated reply wrappers cannot
   * redefine the fixed-position coordinate system. */
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const rect = (event.currentTarget as Element).closest("[data-diffchip]")!.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));
  const total = steps.length + 1; // rows, then diff chips

  useEffect(() => {
    if (live || step >= total) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, total, live]);

  /** VENDORED PATCH：实时模式下「已经显示几行」就是全部行。 */
  const shown = live ? steps.length : step;

  /** VENDORED PATCH：按行下标切换展开（并记下「展开过」，明细据此懒挂载）。 */
  const toggleRow = (index: number, label: string) => {
    setOpenRows((current) => {
      const next = new Set(current);
      const willOpen = !next.has(index);
      willOpen ? next.add(index) : next.delete(index);
      onToggleRow?.(label, willOpen);
      return next;
    });
    setEverOpen((current) => (current.has(index) ? current : new Set(current).add(index)));
  };

  return (
    <div className={`w-full pb-1 ${compact ? "" : "min-h-[220px] max-w-80"}${className ? ` ${className}` : ""}`}>
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            onOpenChange?.(!current);
            return !current;
          })
        }
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums">{copy.header}</span>
      </button>

      {/* tool call rows */}
      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the
            row hover pills room inside this overflow-hidden clip box */}
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
        <div className="mt-1.5 flex flex-col gap-1">
          {steps.slice(0, shown).map((row, rowIndex) => {
            const rowOpen = openRows.has(rowIndex);
            return (
            <div key={`${row.label}#${String(rowIndex)}`} style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <div
                className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
              >
                <button
                  type="button"
                  aria-expanded={rowOpen}
                  aria-label={rowOpen ? `收起 ${row.label} 的明细` : `展开 ${row.label} 的明细`}
                  onClick={() => toggleRow(rowIndex, row.label)}
                  className="flex min-w-0 shrink-0 items-center gap-2 rounded-control text-left"
                >
                <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                  <svg
                    width="13" height="13" viewBox="0 0 24 24" fill={row.icon === "think" ? "currentColor" : "none"} stroke="currentColor"
                    className={`transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`}
                  >
                    {Icons[row.icon]}
                  </svg>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                    className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                    style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-ink">{row.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChipActivate?.(rowIndex, row)}
                  title={onChipActivate === undefined ? row.chip : `${row.chip}（点击打开）`}
                  className={`inline-flex h-5.5 min-w-0 max-w-[52%] shrink items-center rounded-chip bg-field px-1.5
                    text-left text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2
                    ${row.mono ? "font-mono" : ""}`}
                >
                  <span className="truncate">{row.chip}</span>
                </button>
                {/* VENDORED PATCH：输出首行预览。折叠时它是这一行唯一的「结果」，
                    点开行才换成一整块可滚的原文；用 span 占满剩余宽度，右侧对齐不跳。 */}
                <span
                  className={`min-w-0 flex-1 truncate text-[11.5px] ${row.preview === undefined || row.preview === "" ? "" : row.detailMono ? "font-mono" : ""} text-ink-3`}
                  title={row.preview}
                >
                  {row.preview}
                </span>
              </div>

              {/* expanded detail */}
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{ gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
              >
                <div className="min-h-0 overflow-hidden">
                  {/* VENDORED PATCH：不截断、按原文换行、超长自己滚 */}
                  <div className="mt-0.5 mb-1 ml-2 flex max-h-[320px] flex-col gap-1 overflow-y-auto border-l border-line py-0.5 pl-3.5">
                    {(rowOpen || everOpen.has(rowIndex) ? row.detail : []).map((line, lineIndex) => (
                      <div
                        key={`${line.text.slice(0, 32)}#${String(lineIndex)}`}
                        className={`whitespace-pre-wrap break-words text-[11.5px] leading-[1.6] ${row.detailMono ? "font-mono" : ""} ${line.tone === "add" ? "text-green" : "text-ink-2"}`}
                      >
                        {line.text}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>

      {/* file-diff chips */}
      {(live ? diffs.length > 0 : shown >= total && diffs.length > 0) && (
        <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
          {diffs.map((d, i) => (
            <span
              key={d.file}
              data-diffchip
              className="relative"
              onMouseEnter={openPreview(d.file)}
              onMouseLeave={closePreview(d.file)}
            >
              <button
                type="button"
                aria-expanded={preview?.file === d.file}
                aria-label={`Show diff for ${d.file}`}
                onFocus={openPreview(d.file)}
                onBlur={closePreview(d.file)}
                className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip
                  bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn
                  transition-colors duration-100 hover:bg-hover"
                style={{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
              >
                <span className="min-w-0 truncate">{d.file}</span>
                <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                {d.del > 0 && <span className="shrink-0 text-red tabular-nums">−{d.del}</span>}
              </button>

            </span>
          ))}
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3
              underline decoration-transparent underline-offset-2 transition-colors duration-100
              hover:text-ink-2 hover:decoration-current"
            style={{ animation: `fade-in 300ms ease-out ${diffs.length * 80}ms both` }}
          >
            {copy.more}
          </button>
        </div>
      )}
        </div>
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
            <span className="min-w-0 truncate text-ink-2">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">+{diffs.find((diff) => diff.file === preview.file)?.add}</span>
              {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && (
                <span className="text-red"> −{diffs.find((diff) => diff.file === preview.file)?.del}</span>
              )}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8]">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                      ? "bg-red-tint text-red"
                      : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">{line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}</span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
