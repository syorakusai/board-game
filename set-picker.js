const pickers = new WeakMap();
let pickerSequence = 0;

function labelFor(select, label) {
  if (label) return label;
  return [...document.querySelectorAll("label")].find(item => item.htmlFor === select.id)?.textContent?.trim() || "項目";
}

function closePicker(picker) {
  if (!picker || !picker.classList.contains("is-open")) return;
  picker.classList.remove("is-open");
  picker.panel.hidden = true;
  picker.trigger.setAttribute("aria-expanded", "false");
}

function renderPicker(picker) {
  const { select, triggerText, options, title } = picker;
  const selected = select.options[select.selectedIndex];
  triggerText.textContent = selected?.textContent || "選択してください";
  title.textContent = picker.label;
  options.replaceChildren(...[...select.options].map(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-picker-option";
    button.setAttribute("role", "option");
    button.dataset.value = option.value;
    button.setAttribute("aria-selected", String(option.selected));
    button.disabled = option.disabled;
    const text = document.createElement("span");
    text.textContent = option.textContent;
    const mark = document.createElement("span");
    mark.className = "set-picker-option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = option.selected ? "◆" : "";
    button.append(text, mark);
    button.addEventListener("click", () => {
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closePicker(picker);
      picker.trigger.focus();
    });
    return button;
  }));
}

export function enhanceSetSelect(select, label) {
  if (!select || pickers.has(select)) return pickers.get(select);
  const picker = document.createElement("div");
  picker.className = "set-picker";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "set-picker-trigger";
  trigger.id = `set-picker-trigger-${++pickerSequence}`;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", `${labelFor(select, label)}を選ぶ`);
  const triggerText = document.createElement("span");
  triggerText.className = "set-picker-trigger-text";
  const chevron = document.createElement("span");
  chevron.className = "set-picker-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  trigger.append(triggerText, chevron);
  const panel = document.createElement("div");
  panel.className = "set-picker-panel";
  panel.hidden = true;
  const title = document.createElement("p");
  title.className = "set-picker-title";
  const options = document.createElement("div");
  options.className = "set-picker-options";
  options.setAttribute("role", "listbox");
  options.setAttribute("aria-labelledby", trigger.id);
  panel.append(title, options);
  picker.append(trigger, panel);
  picker.select = select;
  picker.trigger = trigger;
  picker.triggerText = triggerText;
  picker.panel = panel;
  picker.title = title;
  picker.options = options;
  picker.label = labelFor(select, label);
  select.classList.add("set-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.insertAdjacentElement("afterend", picker);
  trigger.addEventListener("click", () => {
    const open = !picker.classList.contains("is-open");
    document.querySelectorAll(".set-picker.is-open").forEach(closePicker);
    picker.classList.toggle("is-open", open);
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) options.querySelector('[aria-selected="true"]')?.focus();
  });
  trigger.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    trigger.click();
  });
  select.addEventListener("change", () => renderPicker(picker));
  new MutationObserver(() => renderPicker(picker)).observe(select, { childList: true, subtree: true, characterData: true });
  pickers.set(select, picker);
  renderPicker(picker);
  return picker;
}

export function refreshSetSelect(select) {
  const picker = pickers.get(select);
  if (picker) renderPicker(picker);
}

document.addEventListener("click", event => {
  if (event.target.closest(".set-picker")) return;
  document.querySelectorAll(".set-picker.is-open").forEach(closePicker);
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".set-picker.is-open").forEach(closePicker);
});
