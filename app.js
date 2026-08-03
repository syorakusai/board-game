const state = { playerCount: 0, players: [] };
const screens = document.querySelectorAll("[data-screen]");
const countContainer = document.querySelector("#player-counts");
const nameFields = document.querySelector("#name-fields");
const playerForm = document.querySelector("#player-form");
const formError = document.querySelector("#form-error");

function showScreen(name) {
  screens.forEach((screen) => screen.classList.toggle("is-hidden", screen.dataset.screen !== name));
}

for (let count = 2; count <= 10; count += 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "count-button";
  button.textContent = `${count}人`;
  button.addEventListener("click", () => selectPlayerCount(count));
  countContainer.append(button);
}

function selectPlayerCount(count) {
  state.playerCount = count;
  nameFields.replaceChildren();
  document.querySelector("#name-description").textContent = `${count}人分の名前を入力してください。`;
  for (let index = 0; index < count; index += 1) {
    const label = document.createElement("label");
    label.className = "field-label";
    label.innerHTML = `プレイヤー${index + 1}<input name="player-${index}" maxlength="20" autocomplete="off" placeholder="名前を入力" />`;
    nameFields.append(label);
  }
  formError.textContent = "";
  showScreen("player-names");
  nameFields.querySelector("input")?.focus();
}

document.querySelector("#back-button").addEventListener("click", () => showScreen("player-count"));

playerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const names = [...new FormData(playerForm).values()].map((name) => String(name).trim());
  if (names.some((name) => name.length === 0)) {
    formError.textContent = "すべてのプレイヤー名を入力してください。";
    return;
  }
  if (new Set(names).size !== names.length) {
    formError.textContent = "プレイヤー名は重複しないようにしてください。";
    return;
  }
  state.players = names.map((name, index) => ({ id: index + 1, name, score: 0 }));
  const list = document.querySelector("#player-list");
  list.replaceChildren(...state.players.map((player, index) => {
    const item = document.createElement("div");
    item.className = "player-item";
    item.innerHTML = `<span>${index + 1}. ${escapeHtml(player.name)}</span><span>0ポイント</span>`;
    return item;
  }));
  showScreen("lobby");
});

document.querySelector("#restart-button").addEventListener("click", () => {
  state.players = [];
  showScreen("player-count");
});

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
