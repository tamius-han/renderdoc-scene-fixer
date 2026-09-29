/** Helpers for range sliders that map their 0..1000 position onto a
 * logarithmic 0..max value scale, shared by every filter slider. The scale is
 * log(1 + x/shift): exactly 0 at the left end (a plain log scale can't reach
 * 0), exactly `max` at the right end, and roughly proportional to the
 * position at first, then bending logarithmic. `shift` is the value around
 * which the curve changes from linear to logarithmic - smaller values give
 * more slider travel to small numbers. */
export const LOG_SLIDER_STEPS = 1000;

export function logSliderToValue(position: number, max: number, shift: number): number {
  const t = Math.min(1, Math.max(0, position / LOG_SLIDER_STEPS));
  return shift * Math.expm1(t * Math.log1p(max / shift));
}

export function valueToLogSlider(value: number, max: number, shift: number): number {
  const v = Math.min(max, Math.max(0, value));
  return (LOG_SLIDER_STEPS * Math.log1p(v / shift)) / Math.log1p(max / shift);
}

/** Parses typed decimal text; comma and period both count as the decimal
 * separator and no thousands separators are assumed. Null if not a number. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** "Hide largest % of objects" slider (sidebar and import dialog share it):
 * 0..25 %, logarithmic; the text boxes are linear and clamped to the same
 * limit. Values are kept to one decimal. */
export const HIDE_PERCENT_SLIDER = { max: 25, shift: 0.5 };
