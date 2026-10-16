// Long exercise names in the Builder section editor are cut to two lines on
// phones and short screens (styles.css, [data-clamp-title]). A tap on a cut
// name shows it whole; a second tap folds it again. A name that fits is left
// alone, so a tap on it does nothing.
export const CLAMP_TITLE_SELECTOR = "[data-clamp-title]";

export function toggleClampedTitle(target) {
  const title = target?.closest?.(CLAMP_TITLE_SELECTOR);
  if (!title) return false;
  const expanded = title.classList.contains("is-expanded");
  if (!expanded && title.scrollHeight <= title.clientHeight + 1) return false;
  title.classList.toggle("is-expanded", !expanded);
  return true;
}
