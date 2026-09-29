/** Input types where the user is actually typing text. Checkboxes, radios,
 * range sliders, buttons, colour pickers and file inputs are `<input>`
 * elements too, but keeping focus on one of those (e.g. after clicking a
 * checkbox) must not swallow keyboard shortcuts. */
const TEXT_ENTRY_INPUT_TYPES = new Set(["text", "search", "number", "email", "url", "tel", "password"]);

/** True while keyboard focus is somewhere the user types text. */
export function isTextEntryFocused(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_ENTRY_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}
