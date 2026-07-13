import { escapeAttr, escapeHtml } from "./utils.js";

export function renderFilterableSelect({ name, label, options = [], value = "", required = false, placeholder = "Filter", includeEmpty = "", extraSelectAttrs = "" }) {
  const normalizedValue = String(value || "");
  const selected = options.find((option) => String(option.value) === normalizedValue);
  const visibleValue = normalizedValue ? selected?.label || includeEmpty || "" : "";
  const listId = `org-options-${name}-${Math.random().toString(36).slice(2)}`;
  return `
    <label class="search-field filterable-select-field">
      <span>${escapeHtml(label)}</span>
      <input
        data-org-select-filter
        data-target-select="${escapeAttr(name)}"
        type="search"
        list="${escapeAttr(listId)}"
        placeholder="${escapeAttr(placeholder)}"
        autocomplete="off"
        value="${escapeAttr(visibleValue)}"
        ${required ? "required" : ""}
      >
      <input type="hidden" name="${escapeAttr(name)}" value="${escapeAttr(normalizedValue)}" ${extraSelectAttrs}>
      <datalist id="${escapeAttr(listId)}">
        ${includeEmpty ? `<option value="${escapeAttr(includeEmpty)}" data-value=""></option>` : ""}
        ${options.map((option) => `<option value="${escapeAttr(option.label)}" data-value="${escapeAttr(option.value)}" data-club-id="${escapeAttr(option.clubId || "")}"></option>`).join("")}
      </datalist>
    </label>
  `;
}

export function filterOrganizationSelect(input) {
  const field = input.closest(".filterable-select-field");
  const hiddenInput = field?.querySelector('input[type="hidden"]');
  const list = input.list;
  if (!hiddenInput || !list) return;
  const term = input.value.trim().toLowerCase();
  const form = input.closest("form");
  const selectedClubId = form?.querySelector("[data-organization-club-select]")?.value || "";
  let matchedValue = "";
  Array.from(list.options).forEach((option) => {
    const clubMatches = !option.dataset.clubId || !selectedClubId || option.dataset.clubId === selectedClubId;
    option.hidden = !clubMatches;
    option.disabled = !clubMatches;
    const label = String(option.value || "");
    if (clubMatches && term && label.toLowerCase() === term) matchedValue = option.dataset.value || "";
  });
  hiddenInput.value = matchedValue;
  if (hiddenInput.matches("[data-organization-club-select]")) syncOrganizationTeamSelect(form);
}

export function validateFilterableSelects(form) {
  const invalid = Array.from(form.querySelectorAll(".filterable-select-field"))
    .map((field) => {
      const search = field.querySelector("[data-org-select-filter]");
      const hiddenInput = field.querySelector('input[type="hidden"]');
      if (!search || !hiddenInput || !search.required) return null;
      return hiddenInput.value ? null : search;
    })
    .filter(Boolean);
  invalid[0]?.setCustomValidity("Choose an item from the list.");
  if (invalid[0]) {
    invalid[0].reportValidity();
    invalid[0].setCustomValidity("");
    return false;
  }
  return true;
}

export function syncOrganizationTeamSelect(form) {
  const clubInput = form?.querySelector("[data-organization-club-select]");
  const teamInput = form?.querySelector("[data-organization-team-select]");
  if (!clubInput || !teamInput) return;
  const selectedClubId = clubInput.value;
  const teamField = teamInput.closest(".filterable-select-field");
  const teamSearch = teamField?.querySelector("[data-org-select-filter]");
  const teamOption = Array.from(teamSearch?.list?.options || []).find((option) => option.dataset.value === teamInput.value);
  if (teamOption?.dataset.clubId && selectedClubId && teamOption.dataset.clubId !== selectedClubId) {
    teamInput.value = "";
    if (teamSearch) teamSearch.value = "";
  }
  if (teamSearch) filterOrganizationSelect(teamSearch);
}
