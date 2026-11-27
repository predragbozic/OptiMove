import {escapeAttr,escapeHtml} from './utils.js';
const pictures={
 kpi:'<path d="M18 39H78M27 12V34M43 12H59L52 23H62V34H43M71 12V34"/>',
 table:'<path d="M13 7H83V41H13ZM13 19H83M13 30H83M37 7V41M60 7V41"/>',
 bar_chart:'<path d="M10 42H88M19 41V24H34V41M41 41V11H56V41M63 41V19H78V41"/>',
 standard:'<path d="M8 39L30 20L54 28L86 8"/>',
 area:'<path d="M8 39L30 20L54 28L86 8V42H8Z" fill="currentColor" fill-opacity=".2"/><path d="M8 39L30 20L54 28L86 8"/>',
 horizontal_bar:'<path d="M10 7V42H88"/><path d="M12 11H64V17H12ZM12 23H84V29H12ZM12 35H48V41H12Z" fill="currentColor"/>',
 combined:'<path d="M12 42V25H26V42M39 42V12H53V42M66 42V22H80V42"/><path d="M14 15L44 29L76 6" stroke-width="3"/>',
 heatmap:'<path d="M10 7H88V41H10Z" fill="currentColor" fill-opacity=".12"/><path d="M10 7H35V23H10ZM36 24H61V41H36ZM62 7H88V23H62Z" fill="currentColor" fill-opacity=".75"/><path d="M36 7H61V23H36ZM62 24H88V41H62Z" fill="currentColor" fill-opacity=".4"/>',
 scatter:'<circle cx="19" cy="34" r="3"/><circle cx="33" cy="25" r="3"/><circle cx="48" cy="29" r="3"/><circle cx="60" cy="13" r="3"/><circle cx="80" cy="10" r="3"/>',
 stacked:'<path d="M14 42V26H30V42M42 42V20H58V42M70 42V30H86V42" fill="currentColor" fill-opacity=".6"/><path d="M14 26V14H30V26M42 20V5H58V20M70 30V12H86V30" fill="currentColor" fill-opacity=".2"/>',
 boxplot:'<path d="M12 24H84M12 17V31M84 17V31M30 10H65V38H30ZM47 10V38"/>',
};
export function chartPickerIllustration(kind){
 return `<svg viewBox="0 0 96 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2">${pictures[kind]??pictures.standard}</svg>`;
}
export function renderGalleryPicker(selected,choices,action,disabled=false){return `<div class="tl-gallery-picks">${choices.map(([kind,label])=>`<label class="tl-gallery-pick ${selected===kind?'is-selected':''}"><input type="radio" name="${escapeAttr(action)}" data-action="${escapeAttr(action)}" value="${escapeAttr(kind)}" ${selected===kind?'checked':''} ${disabled?'disabled':''}><svg viewBox="0 0 96 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2">${pictures[kind]??pictures.standard}</svg><span>${escapeHtml(label)}</span></label>`).join('')}</div>`;}
