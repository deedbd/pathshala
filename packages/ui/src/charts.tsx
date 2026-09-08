import { useId, useState } from 'react';
import { formatNumber, type Locale } from './i18n';

/**
 * Two charts, drawn as SVG by hand.
 *
 * No chart library: the release has to stay pure JavaScript with no native build, and a school on a
 * cheap phone should not download three hundred kilobytes to see thirty numbers. Both read the
 * design system's own tokens, so they follow the light and dark palettes without being told, and
 * both carry the numbers as a table underneath for a screen reader and for anybody who would rather
 * read them — a chart is never the only copy of the data.
 */

export interface TrendPoint { label: string; value: number | null }

/**
 * A month of a single measure. A gap in the line is a day nobody marked — a holiday, or a register
 * left unopened — and it is drawn as a gap rather than as a zero, because those are different things
 * and a zero would say the school was empty.
 */
export function TrendLine({ points, locale = 'bn', suffix = '', height = 120, min, max, label }: {
  points: TrendPoint[]; locale?: Locale; suffix?: string; height?: number; min?: number; max?: number; label: string;
}) {
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  const real = points.filter(p => p.value != null) as { label: string; value: number }[];
  if (real.length < 2) return <Empty label={label} />;

  const lo = min ?? Math.max(0, Math.floor(Math.min(...real.map(p => p.value)) - 5));
  const hi = max ?? Math.ceil(Math.max(...real.map(p => p.value)) + 2);
  const span = Math.max(1, hi - lo);
  const w = 640, h = height, padL = 34, padR = 8, padT = 8, padB = 18;
  const x = (i: number) => padL + (i * (w - padL - padR)) / Math.max(1, points.length - 1);
  const y = (v: number) => padT + (h - padT - padB) * (1 - (v - lo) / span);

  // one path per unbroken run, so a gap stays a gap
  const runs: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) { if (run.length > 1) runs.push(run.join(' ')); run = []; return; }
    run.push(`${run.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (run.length > 1) runs.push(run.join(' '));

  const ticks = [lo, lo + span / 2, hi];
  const hover = at != null ? points[at] : null;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-labelledby={`${id}-t`} style={{ overflow: 'visible' }}
        onMouseLeave={() => setAt(null)}
        onMouseMove={e => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - box.left) / box.width) * w;
          const i = Math.round(((rel - padL) / (w - padL - padR)) * (points.length - 1));
          setAt(Math.min(points.length - 1, Math.max(0, i)));
        }}>
        <title id={`${id}-t`}>{label}</title>
        {ticks.map(v => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
            <text x={0} y={y(v) + 3} fontSize={9} fill="var(--muted)">{formatNumber(Math.round(v), locale)}{suffix}</text>
          </g>
        ))}
        {runs.map(d => <path key={d.slice(0, 24)} d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {hover?.value != null && at != null && (
          <g>
            <line x1={x(at)} x2={x(at)} y1={padT} y2={h - padB} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(at)} cy={y(hover.value)} r={4.5} fill="var(--surface)" stroke="var(--accent)" strokeWidth={2} />
          </g>
        )}
        <text x={padL} y={h - 4} fontSize={9} fill="var(--muted)">{points[0]?.label}</text>
        <text x={w - padR} y={h - 4} fontSize={9} fill="var(--muted)" textAnchor="end">{points[points.length - 1]?.label}</text>
      </svg>
      <figcaption className="mt-1 text-xs" style={{ color: 'var(--muted)', minHeight: '1.2em' }}>
        {hover && hover.value != null ? `${hover.label} · ${formatNumber(hover.value, locale)}${suffix}` : label}
      </figcaption>
    </figure>
  );
}

export interface TargetRow { label: string; value: number; target?: number | null }

/**
 * What was collected against what was billed, month by month. The billed figure sits behind as the
 * quieter mark because it is the context, not the answer; the collected figure is the one somebody
 * came to read.
 */
export function TargetBars({ rows, locale = 'bn', height = 140, format, label, valueName, targetName }: {
  rows: TargetRow[]; locale?: Locale; height?: number; format?: (n: number) => string; label: string; valueName: string; targetName: string;
}) {
  const id = useId();
  const [at, setAt] = useState<number | null>(null);
  if (!rows.length) return <Empty label={label} />;
  const fmt = format ?? ((n: number) => formatNumber(n, locale));
  const top = Math.max(1, ...rows.map(r => Math.max(r.value, r.target ?? 0)));
  const w = 640, h = height, padT = 10, padB = 20;
  const slot = w / rows.length;
  const barW = Math.min(38, slot * 0.5);
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / top);

  return (
    <figure className="m-0">
      <div className="mb-1 flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="inline-flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--accent)', borderRadius: 2, display: 'inline-block' }} />{valueName}</span>
        <span className="inline-flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 2, display: 'inline-block' }} />{targetName}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setAt(null)}>
        <title id={`${id}-t`}>{label}</title>
        <line x1={0} x2={w} y1={h - padB} y2={h - padB} stroke="var(--line)" strokeWidth={1} />
        {rows.map((r, i) => {
          const cx = i * slot + slot / 2;
          const target = r.target ?? null;
          return (
            <g key={r.label} onMouseEnter={() => setAt(i)}>
              <rect x={cx - slot / 2} y={0} width={slot} height={h} fill="transparent" />
              {target != null && target > 0 && (
                <rect x={cx - barW / 2 - 3} y={y(target)} width={barW + 6} height={Math.max(1, h - padB - y(target))} rx={4} fill="var(--surface-2)" stroke="var(--line)" strokeWidth={1} />
              )}
              <rect x={cx - barW / 2} y={y(r.value)} width={barW} height={Math.max(1, h - padB - y(r.value))} rx={4} fill="var(--accent)" opacity={at == null || at === i ? 1 : 0.55} />
              <text x={cx} y={h - 6} fontSize={9} fill="var(--muted)" textAnchor="middle">{r.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-xs" style={{ color: 'var(--muted)', minHeight: '1.2em' }}>
        {at != null && rows[at]
          ? `${rows[at]!.label} · ${valueName} ${fmt(rows[at]!.value)}${rows[at]!.target ? ` / ${targetName} ${fmt(rows[at]!.target!)}` : ''}`
          : label}
      </figcaption>
    </figure>
  );
}

/** A chart with nothing in it says so, rather than drawing an empty axis that looks like a fault. */
function Empty({ label }: { label: string }) {
  return <p className="py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>{label}</p>;
}
