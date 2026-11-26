const FIELD_NAMES = ["startTime", "endTime"];
const FIELD_LABELS = ["Starts", "Ends"];
const pad = (value) => String(value).padStart(2, "0");
const wrap = (value, limit) => (value % limit + limit) % limit;

export function bindCentralCalendarTimePicker(calendar) {
  if (!calendar?.classList.contains("cc-layout-phone")) return;
  const inputs = FIELD_NAMES.map((name) => calendar.querySelector(`[data-cc-event-field="${name}"]`));
  if (inputs.some((input) => !input || input.matches(":disabled"))) return;
  const doc = calendar.ownerDocument;
  const controls = doc.createElement("div");
  controls.className = "cc-time-picker";
  controls.innerHTML = `
    <div class="cc-time-picker-editor">
      <div class="cc-time-picker-fields" role="group" aria-label="Time to adjust">
        ${FIELD_LABELS.map((label, index) => `<button type="button" class="plain-button" data-time-field="${index}" aria-pressed="false"><span>${label}</span><strong></strong></button>`).join("")}
      </div>
      <button type="button" class="plain-button cc-time-picker-clear" data-timing="untimed" hidden>Remove time</button>
      <div class="cc-time-picker-wheels" hidden>
        ${["Hour", "Minute"].map((label, index) => `
          <div class="cc-time-wheel" data-time-wheel="${index}" role="group" aria-label="${label}">
            <button type="button" class="plain-button" data-tick="-1" aria-label="Previous ${label.toLowerCase()}"></button>
            <output aria-label="Selected ${label.toLowerCase()}"></output>
            <button type="button" class="plain-button" data-tick="1" aria-label="Next ${label.toLowerCase()}"></button>
          </div>`).join("")}
        <button type="button" class="plain-button cc-time-picker-apply">Set time</button>
      </div>
    </div>`;
  const labels = inputs.map((input) => input.closest("label"));
  const editor = controls.querySelector(".cc-time-picker-editor");
  const wheels = controls.querySelector(".cc-time-picker-wheels");
  const strips = Array.from(wheels.querySelectorAll("[data-time-wheel]"));
  const fields = Array.from(controls.querySelectorAll("[data-time-field]"));
  const clear = controls.querySelector('[data-timing="untimed"]');
  let active = 0;
  let values = [0, 0];

  function updateTimes() {
    fields.forEach((button, index) => {
      button.querySelector("strong").textContent = inputs[index].value || "Set time";
    });
    clear.hidden = !inputs.some((input) => input.value);
  }

  function write(input, value) {
    if (input.value === value) return;
    input.value = value;
    input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  }

  function renderStrip(strip, index) {
    const value = values[index];
    const limit = index === 0 ? 24 : 60;
    strip.querySelector("output").textContent = pad(value);
    strip.querySelectorAll("[data-tick]").forEach((button) => {
      button.textContent = pad(wrap(value + Number(button.dataset.tick), limit));
    });
  }

  fields.forEach((button, index) => button.addEventListener("click", () => {
    active = index;
    const [startHour, startMinute] = (inputs[0].value || "09:00").split(":").map(Number);
    const fallback = index === 1
      ? (startHour === 23 ? "23:59" : `${pad(startHour + 1)}:${pad(startMinute)}`)
      : "09:00";
    values = (inputs[index].value || fallback).split(":").map(Number);
    fields.forEach((field) => field.setAttribute("aria-pressed", String(field === button)));
    strips.forEach(renderStrip);
    wheels.hidden = false;
  }));
  strips.forEach((strip, index) => {
    let start;
    function step(amount) {
      values[index] = wrap(values[index] + amount, index === 0 ? 24 : 60);
      renderStrip(strip, index);
    }
    strip.querySelectorAll("[data-tick]").forEach((button) => button.addEventListener("click", () => step(Number(button.dataset.tick))));
    strip.addEventListener("wheel", (event) => {
      if (!event.deltaY) return;
      event.preventDefault();
      step(Math.sign(event.deltaY));
    }, { passive: false });
    strip.addEventListener("touchstart", (event) => {
      start = event.touches.length === 1 ? event.touches[0].clientY : undefined;
    }, { passive: true });
    strip.addEventListener("touchmove", (event) => {
      if (start === undefined || event.touches.length !== 1) return;
      const steps = Math.trunc((start - event.touches[0].clientY) / 22);
      if (!steps) return;
      if (event.cancelable) event.preventDefault();
      start -= steps * 22;
      step(steps);
    }, { passive: false });
  });
  controls.querySelector(".cc-time-picker-apply").addEventListener("click", () => {
    write(inputs[active], values.map(pad).join(":"));
    wheels.hidden = true;
    fields[active].setAttribute("aria-pressed", "false");
    updateTimes();
    fields[active].focus();
  });
  clear.addEventListener("click", () => {
    inputs.forEach((input) => write(input, ""));
    wheels.hidden = true;
    fields.forEach((field) => field.setAttribute("aria-pressed", "false"));
    updateTimes();
    fields[0].focus();
  });
  labels[0].parentElement.insertBefore(controls, labels[0]);
  labels.forEach((label, index) => {
    label.hidden = true;
    const input = inputs[index];
    const errorId = input.getAttribute("aria-describedby");
    const error = errorId && doc.getElementById(errorId);
    if (error && label.contains(error)) {
      fields[index].setAttribute("aria-invalid", "true");
      fields[index].setAttribute("aria-describedby", errorId);
      editor.append(error);
    }
  });
  updateTimes();
}
