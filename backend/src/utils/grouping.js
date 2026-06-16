const EMPTY_SLOTS = () => ({
  AM: { B: [], T: [], A: [] },
  PM: { B: [], T: [], A: [] },
});

export function normalizeSlot(amPm, bta) {
  return {
    amPm: amPm === "AM" || amPm === "PM" ? amPm : "AM",
    bta: ["B", "T", "A"].includes(bta) ? bta : "T",
  };
}

export function toPlanItem(row) {
  return {
    rowIndex: row.source_row_ref ? Number(row.source_row_ref) || row.source_row_ref : null,
    plan_item_id: row.plan_item_id,
    item_type: row.item_type,
    date: row.date,
    weekStart: row.week_start,
    dayNote: row.day_note || "",
    amPm: row.am_pm || "",
    bta: row.bta || "",
    athlete_id: row.athlete_source_external_id || row.athlete_id || "",
    athlete: row.athlete_name || "",
    athlete_image_url: row.athlete_image_url || "",
    domain: row.domain_name || "",
    domain_order: numberOrNull(row.domain_order),
    domain_color: row.domain_color || "",
    domain_icon_url: row.domain_icon_url || "",
    domain_short_note: row.domain_short_note || "",
    domain_note: row.domain_note || "",
    category: row.category_name || "",
    category_order: numberOrNull(row.category_order),
    category_color: row.category_color || "",
    category_icon_url: row.category_icon_url || "",
    category_short_note: row.category_short_note || "",
    category_note: row.category_note || "",
    section: row.section_name || "",
    section_order: numberOrNull(row.section_order),
    section_color: row.section_color || "",
    section_icon_url: row.section_icon_url || "",
    section_short_note: row.section_short_note || "",
    section_note: row.section_note || "",
    title: row.title || "",
    description: row.description || "",
    image: row.image_url || "",
    video: row.video_url || "",
    exercise_order: numberOrNull(row.exercise_order),
    sets: row.sets || "",
    reps: row.reps || "",
    load: row.load || "",
    order: numberOrNull(row.item_order) ?? 9999,
    exercise_id: row.exercise_id || null,
    exercise_code: row.exercise_code || "",
    library_exercise_name: row.library_exercise_name || "",
  };
}

export function buildWeeks(rows) {
  const weeks = new Map();

  rows.forEach((row) => {
    const item = toPlanItem(row);
    if (!item.weekStart || !item.date) return;

    if (!weeks.has(item.weekStart)) {
      weeks.set(item.weekStart, {
        weekStart: item.weekStart,
        weekEnd: row.week_end,
        days: buildWeekDays(item.weekStart),
      });
    }

    const week = weeks.get(item.weekStart);
    const day = week.days.find((entry) => entry.date === item.date);
    if (!day) return;
    if (!day.dayNote && item.dayNote) day.dayNote = item.dayNote;

    const slot = normalizeSlot(item.amPm, item.bta);
    day.slots[slot.amPm][slot.bta].push(item);
  });

  return Array.from(weeks.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function buildPrograms(programSummaries, itemRowsByPlanId) {
  return programSummaries.map((program) => {
    const rows = itemRowsByPlanId.get(program.plan_id) || [];
    const data = buildProgramData(program, rows);
    return {
      id: program.plan_id,
      name: program.plan_name,
      programOrder: numberOrNull(program.program_order),
      note: "",
      icon: "",
      durationLabel: program.duration_days ? `${program.duration_days} days` : "",
      data,
    };
  });
}

export function buildProgramData(program, rows) {
  const hasMicrocycles = rows.some((row) => row.block_name && row.block_type === "week_day");
  const items = rows.map(toPlanItem);

  if (hasMicrocycles) {
    return {
      mode: "microcycle",
      microcycles: buildMicrocycles(rows),
      weeks: [],
      dayGroups: [],
      rows: items,
      hasAmPm: rows.some((row) => row.am_pm === "AM" || row.am_pm === "PM"),
      hasBta: rows.some((row) => ["B", "T", "A"].includes(row.bta)),
      programLabel: program.plan_name,
    };
  }

  return {
    mode: "daynote",
    weeks: [],
    dayGroups: buildDayNoteGroups(rows),
    microcycles: [],
    rows: items,
    hasAmPm: rows.some((row) => row.am_pm === "AM" || row.am_pm === "PM"),
    hasBta: rows.some((row) => ["B", "T", "A"].includes(row.bta)),
    programLabel: program.plan_name,
  };
}

function buildWeekDays(weekStart) {
  const start = new Date(`${weekStart}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      dayNote: "",
      slots: EMPTY_SLOTS(),
    };
  });
}

function buildDayNoteGroups(rows) {
  const groups = new Map();

  rows.forEach((row) => {
    const item = toPlanItem(row);
    const key = row.block_name || row.day_note || "Program";
    if (!groups.has(key)) {
      groups.set(key, { dayNote: key, slots: EMPTY_SLOTS() });
    }
    const slot = normalizeSlot(item.amPm, item.bta);
    groups.get(key).slots[slot.amPm][slot.bta].push(item);
  });

  return Array.from(groups.values());
}

function buildMicrocycles(rows) {
  const microcycles = new Map();

  rows.forEach((row) => {
    const blockName = row.block_name || "Program";
    const [microcycleName, ...dayParts] = blockName.split(" - ");
    const dayNote = dayParts.join(" - ") || blockName;

    if (!microcycles.has(microcycleName)) {
      microcycles.set(microcycleName, { name: microcycleName, dayGroups: new Map() });
    }
    const microcycle = microcycles.get(microcycleName);
    if (!microcycle.dayGroups.has(dayNote)) {
      microcycle.dayGroups.set(dayNote, { dayNote, slots: EMPTY_SLOTS() });
    }

    const item = toPlanItem(row);
    const slot = normalizeSlot(item.amPm, item.bta);
    microcycle.dayGroups.get(dayNote).slots[slot.amPm][slot.bta].push(item);
  });

  return Array.from(microcycles.values()).map((microcycle) => ({
    name: microcycle.name,
    dayGroups: Array.from(microcycle.dayGroups.values()),
  }));
}

function numberOrNull(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
