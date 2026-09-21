import type { HTMLAttributes, ReactNode } from "react";

/*
 * ⚠️ VENDORED PATCH：上游这两个构件只声明了自己的 props，没有 `...props` 透传，
 * 于是 `title` / `aria-*` / `data-*` 都传不进去（我们的界面到处用它挂 tooltip）。
 * 这里给它们的根元素加上原生属性透传 —— 行为不变，只是多接一层属性。
 */

/** Monogram mark — a colored disc with an initial or short glyph.
 *  The shared building block for entity chips and monogram headings. */
export function Monogram({
  children,
  color = "#e08a3c",
  className = "",
  ...props
}: {
  children: ReactNode;
  color?: string;
  className?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-full
        text-[9px] font-semibold leading-none text-white ${className}`}
      style={{ background: color }}
      {...props}
    >
      {children}
    </span>
  );
}

/** Inline entity reference — a monogram + name in a soft field pill.
 *  Names a supplier, person, or record inside running text. Softer than a
 *  StatusPill (no dot, no state) and not a mono token (see Chip). */
export function EntityChip({
  name,
  color,
  monogram,
  className = "",
  ...props
}: {
  name: string;
  color?: string;
  monogram?: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full bg-field
        py-px pl-[3px] pr-1.5 align-middle shadow-hairline ${className}`}
      {...props}
    >
      <Monogram color={color}>{monogram ?? name.charAt(0)}</Monogram>
      <span className="text-[12px] font-medium text-ink">{name}</span>
    </span>
  );
}
