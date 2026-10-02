/**
 * Form-event helpers. The root type check deliberately has no DOM library (D-062: it would break the
 * simulator's fetch typing), so a change event's target is read through these two tiny accessors.
 */
export const fieldValue = (e: { readonly target: unknown }): string =>
  (e.target as { value: string }).value;
export const fieldChecked = (e: { readonly target: unknown }): boolean =>
  (e.target as { checked: boolean }).checked;
