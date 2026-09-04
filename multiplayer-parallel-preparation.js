import { getFirebaseContext } from "./firebase-client.js";
import { get, onValue, ref, serverTimestamp, set, update } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

// develop専用。
// 各「席」の冒頭で全員が自分の将来の親番を同時並行で準備し、
// 全員の「ひそめる」完了後は既存の multiplayer-phase1.js の番手進行へ接続する。

const SESSION_KEY = "board-game:dev:multiplayer-room-session";
const ATTACH_INTERVAL_MS = 500;
const DISCUSSION_INTRO_MIDDLE_MS = 800;
const DISCUSSION_INTRO_BOTTOM_MS = 1600;
const DISCUSSION_INTRO_FADE_MS = 3100;
const DISCUSSION_INTRO_DURATION_MS = 3600;

window.__multiplayerDiscussionIntroDurationMs = DISCUSSION_INTRO_DURATION_MS;

let database = null;
let user = null;
let roomId = "";
let latestRoom = null;
let roomPresence = {};
let preparationProgress = {};
let ownPreparation = null;
let multiplayerHistory = {};
let roomUnsubscribe = null;
let presenceUnsubscribe = null;
let progressUnsubscribe = null;
let preparationUnsubscribe = null;
let historyUnsubscribe = null;
let preparationSubscriptionKey = "";
let progressSubscriptionKey = "";
let activationKey = "";
let drawPending = false;
let submitPending = false;
let redrawPending = false;
let attachPending = false;
let editingKey = "";
let catalog = [];
let yokaiByNumber = null;
let yokaiCatalogPromise = null;
let historyWrapped = false;
let discussionIntroKey = "";
let discussionIntroTimers = [];
const completedDiscussionIntros = new Set();

const $ = selector => document.querySelector(selector);
const roomPath = id => `rooms/${id}`;
const presencePath = id => `roomPresence/${id}`;
const reservationPath = (id, cardId) => `roomCardReservations/${id}/${cardId}`;
const privatePreparationPath = (id, cycleNumber, uid) => `roomPreparations/${id}/cycles/${cycleNumber}/${uid}`;
const preparationProgressPath = (id, cycleNumber, uid = "") => `roomPreparationProgress/${id}/cycles/${cycleNumber}${uid ? `/${uid}` : ""}`;
const roundSecretPath = (id, roundNumber, uid) => `roomSecrets/${id}/rounds/${roundNumber}/${uid}`;
const historyPath = id => `roomHistories/${id}`;

function storedSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function japaneseNumber(number) {
  const fixed = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return fixed[Number(number)] || String(number);
}

function turnInfo(room = latestRoom) {
  const count = Array.isArray(room?.seats) ? room.seats.length : 0;
  const roundNumber = Math.max(1, Number(room?.round?.number) || 1);
  const explicitCycle = Number(room?.round?.cycleNumber);
  const explicitTurn = Number(room?.round?.turnNumber);
  if (!count) return { count: 0, roundNumber, cycleNumber: 1, turnNumber: 0 };
  return {
    count,
    roundNumber,
    cycleNumber: Number.isInteger(explicitCycle) && explicitCycle >= 1 ? explicitCycle : Math.floor((roundNumber - 1) / count) + 1,
    turnNumber: Number.isInteger(explicitTurn) && explicitTurn >= 0 ? explicitTurn : ((roundNumber - 1) % count) + 1
  };
}

function seatLabel(cycleNumber) {
  return `第${japaneseNumber(cycleNumber)}席`;
}

function turnLabel(turnNumber) {
  return `${japaneseNumber(turnNumber)}番手`;
}

function isConnected(uid) {
  return Object.keys(roomPresence?.[uid] || {}).length > 0;
}

function allPlayersConnected(room = latestRoom) {
  return Array.isArray(room?.seats) && room.seats.length > 0 && room.seats.every(isConnected);
}

function preparationStatus(uid) {
  const status = preparationProgress?.[uid]?.status;
  return status === "complete" || status === "hiding" ? status : "draw";
}

function allPreparationsComplete(room = latestRoom) {
  const { cycleNumber } = turnInfo(room);
  return Array.isArray(room?.seats)
    && room.seats.length > 0
    && room.seats.every(uid => preparationStatus(uid) === "complete");
}

function activationDebug(event, detail = {}) {
  window.__multiplayerResumeDebug?.(`preparation:${event}`, detail);
}

function clearDiscussionIntroTimers() {
  discussionIntroTimers.forEach(clearTimeout);
  discussionIntroTimers = [];
}

function discussionIntroOverlay() {
  let overlay = $("#multiplayer-discussion-intro");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "multiplayer-discussion-intro";
  overlay.className = "multiplayer-discussion-intro is-hidden";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `<div class="multiplayer-discussion-intro-panel" role="status" aria-live="polite">
    <div class="multiplayer-discussion-intro-line multiplayer-discussion-intro-position"></div>
    <div class="multiplayer-discussion-intro-line multiplayer-discussion-intro-parent"></div>
    <div class="multiplayer-discussion-intro-line multiplayer-discussion-intro-start">推理開始</div>
  </div>`;
  document.body.append(overlay);
  return overlay;
}

function hideDiscussionIntro() {
  clearDiscussionIntroTimers();
  discussionIntroKey = "";
  const overlay = $("#multiplayer-discussion-intro");
  overlay?.classList.add("is-hidden");
  overlay?.setAttribute("aria-hidden", "true");
}

function setDiscussionIntroStage(stage) {
  const overlay = discussionIntroOverlay();
  overlay.classList.remove("is-hidden", "is-leaving", "is-stage-1", "is-stage-2", "is-stage-3");
  overlay.classList.add(`is-stage-${stage}`);
  overlay.setAttribute("aria-hidden", "false");
}

function scheduleDiscussionIntroStage(stage, delay) {
  if (delay <= 0) return;
  discussionIntroTimers.push(setTimeout(() => setDiscussionIntroStage(stage), delay));
}

function syncDiscussionIntro(room = latestRoom) {
  const { cycleNumber, turnNumber, roundNumber } = turnInfo(room);
  const waitingForFirstTurn = isPreparationPhase(room) && allPreparationsComplete(room) && allPlayersConnected(room);
  const activeTurnNumber = waitingForFirstTurn ? 1 : turnNumber;
  const parentUid = waitingForFirstTurn ? room?.seats?.[0] : room?.parentUid;
  const supportedPhase = waitingForFirstTurn || (activeTurnNumber > 0 && ["draw", "parent-word", "discussion"].includes(room?.round?.phase));
  if (!room || room.status !== "started" || room.endedBy || !parentUid || !supportedPhase) {
    hideDiscussionIntro();
    return;
  }
  const key = `${roomId}:${roundNumber}`;
  if (completedDiscussionIntros.has(key)) {
    hideDiscussionIntro();
    return;
  }
  const overlay = discussionIntroOverlay();
  overlay.querySelector(".multiplayer-discussion-intro-position").textContent = `${seatLabel(cycleNumber)}　${turnLabel(activeTurnNumber)}`;
  overlay.querySelector(".multiplayer-discussion-intro-parent").textContent = `親：${room.players?.[parentUid]?.name || "親"}`;
  if (discussionIntroKey !== key) {
    clearDiscussionIntroTimers();
    discussionIntroKey = key;
    setDiscussionIntroStage(1);
  }
  const startedAt = Number(room.round?.discussionStartedAt);
  if (room.round?.phase !== "discussion" || !Number.isFinite(startedAt)) return;
  clearDiscussionIntroTimers();
  const now = window.multiplayerPhase1?.serverNow?.() || Date.now();
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed >= DISCUSSION_INTRO_DURATION_MS) {
    completedDiscussionIntros.add(key);
    hideDiscussionIntro();
    return;
  }
  if (elapsed >= DISCUSSION_INTRO_BOTTOM_MS) setDiscussionIntroStage(3);
  else if (elapsed >= DISCUSSION_INTRO_MIDDLE_MS) setDiscussionIntroStage(2);
  else setDiscussionIntroStage(1);
  scheduleDiscussionIntroStage(2, DISCUSSION_INTRO_MIDDLE_MS - elapsed);
  scheduleDiscussionIntroStage(3, DISCUSSION_INTRO_BOTTOM_MS - elapsed);
  discussionIntroTimers.push(setTimeout(() => overlay.classList.add("is-leaving"), Math.max(0, DISCUSSION_INTRO_FADE_MS - elapsed)));
  discussionIntroTimers.push(setTimeout(() => {
    completedDiscussionIntros.add(key);
    hideDiscussionIntro();
  }, Math.max(0, DISCUSSION_INTRO_DURATION_MS - elapsed)));
}

function isPreparationPhase(room = latestRoom) {
  const { turnNumber } = turnInfo(room);
  return room?.status === "started" && !room?.endedBy && room?.round?.phase === "draw" && turnNumber === 0 && !room?.parentUid;
}

function showScreen(name) {
  if (typeof window.showGameScreen === "function") {
    window.showGameScreen(name);
    return;
  }
  document.querySelectorAll("[data-screen]").forEach(screen => {
    screen.classList.toggle("is-hidden", screen.dataset.screen !== name);
  });
}

function placeRoundTitle(screenName, text) {
  const slot = $("#multiplayer-round-title-slot");
  const screen = document.querySelector(`[data-screen="${screenName}"]`);
  if (!slot || !screen) return;
  const previous = slot.querySelector(".screen-title-row");
  if (previous?.dataset.multiplayerScreen && previous.dataset.multiplayerScreen !== screenName) {
    document.querySelector(`[data-screen="${previous.dataset.multiplayerScreen}"]`)?.prepend(previous);
  }
  const row = screen.querySelector(".screen-title-row") || (previous?.dataset.multiplayerScreen === screenName ? previous : null);
  if (row) {
    row.dataset.multiplayerScreen = screenName;
    if (row.parentElement !== slot) slot.append(row);
    const title = row.querySelector("[data-round-title]");
    if (title) title.textContent = text;
  } else {
    const title = screen.querySelector("[data-round-title]");
    if (title) title.textContent = text;
  }
  const header = $("#multiplayer-round-header");
  const shell = $(".app-shell");
  header?.classList.remove("is-hidden");
  shell?.classList.add("has-multiplayer-round-header");
  requestAnimationFrame(() => {
    if (header && shell && !header.classList.contains("is-hidden")) {
      shell.style.setProperty("--multiplayer-round-header-height", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    }
  });
}

function setRoundMessage(message) {
  const viewport = $("#multiplayer-message-bar");
  const track = $("#multiplayer-message-text");
  if (!viewport || !track) return;
  const previousFrame = Number(track.dataset.prepTickerFrame);
  if (Number.isFinite(previousFrame)) cancelAnimationFrame(previousFrame);
  track.classList.remove("is-scrolling");
  track.style.removeProperty("--multiplayer-message-duration");
  track.style.removeProperty("--multiplayer-message-distance");
  track.style.removeProperty("--multiplayer-message-start");
  const primary = document.createElement("span");
  primary.className = "multiplayer-message-copy";
  primary.textContent = message;
  track.replaceChildren(primary);
  const frame = requestAnimationFrame(() => {
    if (primary.scrollWidth <= viewport.clientWidth + 1) return;
    const duplicate = primary.cloneNode(true);
    duplicate.dataset.tickerCopy = "";
    duplicate.setAttribute("aria-hidden", "true");
    track.append(duplicate);
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const distance = primary.getBoundingClientRect().width + gap;
    const startOffset = viewport.clientWidth / 2;
    const duration = Math.max(6, distance / 63);
    track.style.setProperty("--multiplayer-message-duration", `${duration.toFixed(2)}s`);
    track.style.setProperty("--multiplayer-message-start", `${startOffset.toFixed(2)}px`);
    track.style.setProperty("--multiplayer-message-distance", `${-distance.toFixed(2)}px`);
    track.classList.add("is-scrolling");
  });
  track.dataset.prepTickerFrame = String(frame);
}

function patchPreparationPlayerBar(room, cycleNumber) {
  const bar = $("#multiplayer-player-bar");
  if (!bar || !Array.isArray(room?.seats)) return;
  const panels = [...bar.querySelectorAll(".multiplayer-player")];
  room.seats.forEach((uid, index) => {
    const panel = panels[index];
    if (!panel) return;
    panel.classList.remove("is-parent");
    panel.querySelector(".multiplayer-player-role")?.remove();
    const status = panel.querySelector("small");
    if (!status) return;
    status.className = "";
    if (!isConnected(uid)) {
      status.textContent = "切断中";
      status.classList.add("is-disconnected");
      return;
    }
    const state = preparationStatus(uid);
    status.textContent = state === "complete" ? "完了" : state === "hiding" ? "ひそめ中" : "札選び中";
    status.classList.add(state === "complete" ? "is-complete" : "is-action-needed");
  });
}

function patchScorePlayerBar(room) {
  if (room?.round?.phase !== "score" || !room?.parentUid) return;
  const { turnNumber, count } = turnInfo(room);
  const nextLabel = turnNumber < count ? "次の番手へ" : "次の席へ";
  const index = room.seats.indexOf(room.parentUid);
  const panel = $("#multiplayer-player-bar")?.querySelectorAll(".multiplayer-player")?.[index];
  const status = panel?.querySelector("small");
  if (status) {
    status.textContent = nextLabel;
    status.className = "is-action-needed";
  }
  const button = $("#next-round");
  if (button) button.textContent = nextLabel;
  const parentName = room.players?.[room.parentUid]?.name || "親";
  setRoundMessage(`得点が反映されました。${parentName}さん、${nextLabel}進んでください。`);
}

function patchActivePhase(room) {
  if (!room || room.status !== "started") return;
  const { cycleNumber, turnNumber } = turnInfo(room);
  const phases = {
    discussion: ["discussion", "宴の推理"],
    answer: ["answer", "推理結果の記帳"],
    reveal: ["result-open", "ひそめごと開帳"],
    result: ["result", "宴の顛末"],
    score: ["scores", "得点の記録"]
  };
  const selected = phases[room?.round?.phase];
  if (selected) placeRoundTitle(selected[0], `${seatLabel(cycleNumber)}　${turnLabel(turnNumber)}　${selected[1]}`);
  patchScorePlayerBar(room);
}

function cardMarkup(image) {
  return image
    ? `<img class="card-zoom-trigger" src="${escapeHtml(image)}" alt="お題カード。タップで拡大表示">`
    : `<div class="missing-card">カード画像を読み込めません</div>`;
}

async function ensureCatalog() {
  if (catalog.length) return catalog;
  const listing = await (await fetch("card-sets.json")).json();
  catalog = await Promise.all((listing.cardSetIds || []).map(async id => await (await fetch(`cards/${id}/cards.json`)).json()));
  return catalog;
}

function secureShuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [result[index], result[random]] = [result[random], result[index]];
  }
  return result;
}

function yokaiNumberFromImage(image) {
  const filename = typeof image === "string" ? image.split("/").pop() : "";
  if (!filename?.endsWith(".webp")) return null;
  const parts = filename.slice(0, -5).split("_");
  if (parts.length < 3 || !/^\d+$/.test(parts[1])) return null;
  const number = Number(parts[1]);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function ensureYokaiCatalog() {
  if (yokaiByNumber) return yokaiByNumber;
  if (yokaiCatalogPromise) return yokaiCatalogPromise;
  yokaiCatalogPromise = fetch("data/yokai.json")
    .then(response => response.ok ? response.json() : [])
    .then(entries => {
      const next = new Map();
      if (Array.isArray(entries)) {
        entries.forEach(entry => {
          const number = Number(entry?.number);
          if (Number.isSafeInteger(number) && number >= 0) next.set(number, entry);
        });
      }
      yokaiByNumber = next;
      return next;
    })
    .catch(() => {
      yokaiByNumber = new Map();
      return yokaiByNumber;
    })
    .finally(() => { yokaiCatalogPromise = null; });
  return yokaiCatalogPromise;
}

async function renderCompletedLore(preparation) {
  const element = $("#parent-card-lore");
  if (!element) return false;
  await ensureYokaiCatalog();
  if (ownPreparation !== preparation || preparation?.status !== "complete") return false;
  const number = yokaiNumberFromImage(preparation.cardImage);
  const lore = number === null ? null : yokaiByNumber?.get(number) || null;
  element.hidden = !lore;
  element.innerHTML = lore ? (() => {
    const numeric = Number(lore.number);
    const numberLabel = Number.isInteger(numeric) && numeric > 0 ? `No.${String(numeric).padStart(4, "0")}` : "";
    return `<section class="parent-card-lore-panel" aria-label="妖怪紹介">
      <h2 class="parent-card-lore-name">${escapeHtml(lore.name || "")}</h2>
      <div class="parent-card-lore-entry"><h3>【出現】</h3><p>${escapeHtml(lore.appearance || "")}</p></div>
      <div class="parent-card-lore-entry"><h3>【特質】</h3><p>${escapeHtml(lore.traits || "")}</p></div>
      <p class="parent-card-lore-number">${escapeHtml(numberLabel)}</p>
    </section>`;
  })() : "";
  return Boolean(lore);
}

function preparationError(message) {
  const error = $("#parent-error");
  if (error) {
    error.hidden = false;
    error.textContent = message;
  }
}

function renderPreparationDraw(room) {
  const { cycleNumber } = turnInfo(room);
  showScreen("round");
  placeRoundTitle("round", `${seatLabel(cycleNumber)}　札選び`);
  patchPreparationPlayerBar(room, cycleNumber);
  const deck = $("#deck-stack-image");
  const button = $("#round-start-button");
  const drawText = $("#draw-card");
  const status = $("#draw-status");
  const error = $("#round-card-message");
  const enabled = allPlayersConnected(room) && !drawPending;
  if (button) {
    button.hidden = false;
    button.disabled = !enabled;
    button.onclick = drawPreparedCard;
  }
  if (deck) {
    deck.classList.remove("is-passive");
    deck.setAttribute("aria-disabled", String(!enabled));
    deck.tabIndex = 0;
    deck.onclick = drawPreparedCard;
    deck.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        drawPreparedCard();
      }
    };
  }
  if (drawText) drawText.textContent = allPlayersConnected(room) ? "伏せ札を引く" : "復帰を待っています";
  if (status) status.hidden = !drawPending;
  if (error && !drawPending) {
    error.textContent = "";
    error.hidden = true;
  }
  const name = room.players?.[user?.uid]?.name || "客人";
  setRoundMessage(`${name}さん、伏せ札の山から1枚引いてください。`);
}

function renderPreparationHiding(room, preparation) {
  const { cycleNumber } = turnInfo(room);
  showScreen("parent-input");
  placeRoundTitle("parent-input", `${seatLabel(cycleNumber)}　親のひそめごと`);
  patchPreparationPlayerBar(room, cycleNumber);
  $("#parent-card-area").innerHTML = cardMarkup(preparation?.cardImage);
  const lore = $("#parent-card-lore");
  if (lore) { lore.hidden = true; lore.innerHTML = ""; }
  const description = $("#parent-secret-description");
  if (description) { description.hidden = false; description.textContent = "4つ目にあなたのワードを入力してください。"; }
  const official = $("#official-preview");
  if (official) {
    official.hidden = false;
    official.innerHTML = Array.isArray(preparation?.officialWords)
      ? preparation.officialWords.map(word => `<div class="word official">${escapeHtml(word)}</div>`).join("")
      : "";
  }
  const input = $("#parent-word");
  const currentEditingKey = `${roomId}:${cycleNumber}:${preparation?.cardId || ""}`;
  if (input) {
    input.hidden = false;
    if (editingKey !== currentEditingKey) input.value = "";
  }
  editingKey = currentEditingKey;
  const error = $("#parent-error");
  if (error) { error.hidden = false; if (!submitPending && !redrawPending) error.textContent = ""; }
  const submit = $("#parent-submit");
  if (submit) {
    submit.hidden = false;
    submit.textContent = "ひそめる";
    submit.disabled = !allPlayersConnected(room) || submitPending || redrawPending || !Array.isArray(preparation?.officialWords);
    submit.onclick = confirmPreparedWord;
  }
  const redraw = $("#parent-redraw-button");
  if (redraw) {
    redraw.hidden = false;
    redraw.disabled = !allPlayersConnected(room) || submitPending || redrawPending;
    redraw.onclick = redrawPreparedCard;
  }
  setRoundMessage("公式ワード3つを確認し、親ワードをひそめてください。");
}

function renderPreparationComplete(room, preparation) {
  const { cycleNumber } = turnInfo(room);
  showScreen("parent-input");
  placeRoundTitle("parent-input", `${seatLabel(cycleNumber)}　親のひそめごと`);
  patchPreparationPlayerBar(room, cycleNumber);
  $("#parent-card-area").innerHTML = cardMarkup(preparation?.cardImage);
  ["#parent-secret-description", "#official-preview", "#parent-word", "#parent-error", "#parent-submit", "#parent-redraw-button"].forEach(selector => {
    const element = $(selector);
    if (element) element.hidden = true;
  });
  const official = $("#official-preview");
  if (official) official.replaceChildren();
  const input = $("#parent-word");
  if (input) input.value = "";
  const allComplete = allPreparationsComplete(room);
  setRoundMessage(allComplete
    ? "全員のひそめごとが完了しました。一番手を開始しています。"
    : "全員のひそめごとが終わるまでお待ちください。");
  void renderCompletedLore(preparation).then(hasLore => {
    if (!hasLore
      || allComplete
      || ownPreparation !== preparation
      || !isPreparationPhase(latestRoom)
      || allPreparationsComplete(latestRoom)) return;
    setRoundMessage("全員のひそめごとが終わるまでお待ちください。待ち時間の間にこのイラストの物語をご堪能ください。");
  });
}

function renderPreparation(room = latestRoom) {
  if (!room || !user || !isPreparationPhase(room)) return;
  const { cycleNumber } = turnInfo(room);
  patchPreparationPlayerBar(room, cycleNumber);
  const status = preparationStatus(user.uid);
  if (status === "complete" && ownPreparation?.status === "complete") renderPreparationComplete(room, ownPreparation);
  else if (status === "hiding" && ownPreparation?.cardId) renderPreparationHiding(room, ownPreparation);
  else renderPreparationDraw(room);
}

async function setPreparationStatus(cycleNumber, status) {
  if (!database || !roomId || !user?.uid) return;
  if (preparationProgress?.[user.uid]?.status === status) return;
  await set(ref(database, preparationProgressPath(roomId, cycleNumber, user.uid)), {
    status,
    updatedAt: serverTimestamp()
  });
}

async function restoreOwnPresenceStatus() {
  if (!latestRoom || !user?.uid || !isPreparationPhase(latestRoom)) return;
  const { cycleNumber } = turnInfo(latestRoom);
  const status = ownPreparation?.status === "complete" ? "complete" : ownPreparation?.cardId ? "hiding" : "draw";
  try {
    await setPreparationStatus(cycleNumber, status);
  } catch (error) {
    console.warn("仕込み状態を共有できませんでした。", error);
  }
}

async function claimReservation(room, cycleNumber, cardId) {
  try {
    await set(ref(database, reservationPath(roomId, cardId)), {
      uid: user.uid,
      feastId: room.feastId,
      cycleNumber,
      claimedAt: serverTimestamp()
    });
    return true;
  } catch (error) {
    const description = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
    if (description.includes("permission")) return false;
    throw error;
  }
}

async function drawPreparedCard() {
  const room = latestRoom;
  if (!room || !user?.uid || drawPending || !isPreparationPhase(room) || !allPlayersConnected(room)) return;
  const { cycleNumber } = turnInfo(room);
  drawPending = true;
  renderPreparationDraw(room);
  try {
    await ensureCatalog();
    const cardSet = catalog.find(setData => setData.id === room.cardSet);
    const wordSet = cardSet?.wordSets?.find(setData => setData.id === room.wordSet);
    const candidates = secureShuffle(cardSet?.cards || []);
    let selected = null;
    for (const card of candidates) {
      if (await claimReservation(room, cycleNumber, card.id)) {
        selected = card;
        break;
      }
    }
    if (!selected) throw Error("引ける札がありません。");
    const wordCard = wordSet?.cards?.find(item => String(item.cardId) === String(selected.id));
    const officialWords = secureShuffle(wordCard?.officialWords || []).slice(0, 3);
    if (officialWords.length !== 3) throw Error("公式ワードを3個選べませんでした。");
    const preparation = {
      status: "hiding",
      cycleNumber,
      cardId: selected.id,
      cardImage: `cards/${room.cardSet}/${selected.image}`,
      officialWords,
      createdAt: Date.now()
    };
    await set(ref(database, privatePreparationPath(roomId, cycleNumber, user.uid)), preparation);
    ownPreparation = preparation;
    editingKey = "";
    await setPreparationStatus(cycleNumber, "hiding");
  } catch (error) {
    const message = $("#round-card-message");
    if (message) {
      message.hidden = false;
      message.textContent = `札を引けませんでした。${error.message || ""}`;
    }
  } finally {
    drawPending = false;
    if (isPreparationPhase(latestRoom)) renderPreparation(latestRoom);
  }
}

async function redrawPreparedCard() {
  const room = latestRoom;
  if (!room || redrawPending || !isPreparationPhase(room) || !allPlayersConnected(room)) return;
  const { cycleNumber } = turnInfo(room);
  redrawPending = true;
  try {
    const replacement = { status: "draw", cycleNumber, updatedAt: Date.now() };
    await set(ref(database, privatePreparationPath(roomId, cycleNumber, user.uid)), replacement);
    ownPreparation = replacement;
    editingKey = "";
    await setPreparationStatus(cycleNumber, "draw");
  } catch (error) {
    preparationError(`札を引き直せませんでした。${error.message || ""}`);
  } finally {
    redrawPending = false;
    if (isPreparationPhase(latestRoom)) renderPreparation(latestRoom);
  }
}

async function confirmPreparedWord() {
  const room = latestRoom;
  const value = $("#parent-word")?.value.trim() || "";
  if (!room || submitPending || !isPreparationPhase(room) || !allPlayersConnected(room) || !ownPreparation?.cardId) return;
  if (!value) {
    preparationError("親ワードを入力してください。");
    return;
  }
  if (ownPreparation.officialWords?.includes(value)) {
    preparationError("公式ワードとは別の言葉を入力してください。");
    return;
  }
  const { cycleNumber } = turnInfo(room);
  submitPending = true;
  try {
    const publicWords = secureShuffle([...ownPreparation.officialWords, value]);
    const parentCandidateIndex = publicWords.indexOf(value);
    const completed = {
      ...ownPreparation,
      status: "complete",
      parentWord: value,
      publicWords,
      parentCandidateIndex,
      parentWordConfirmedAt: Date.now()
    };
    await set(ref(database, privatePreparationPath(roomId, cycleNumber, user.uid)), completed);
    ownPreparation = completed;
    await setPreparationStatus(cycleNumber, "complete");
    editingKey = "";
  } catch (error) {
    preparationError(`親ワードをひそめられませんでした。${error.message || ""}`);
  } finally {
    submitPending = false;
    if (isPreparationPhase(latestRoom)) renderPreparation(latestRoom);
    void maybeActivatePreparedTurn(latestRoom);
  }
}

async function maybeActivatePreparedTurn(room = latestRoom) {
  if (!room || !database || !user?.uid || room.status !== "started" || room.round?.phase !== "draw" || !allPlayersConnected(room)) return;
  const { cycleNumber, turnNumber, roundNumber } = turnInfo(room);
  if (turnNumber === 0) {
    if (!room.players?.[user.uid] || !allPreparationsComplete(room)) return;
    const startKey = `${roomId}:${roundNumber}:start-activation`;
    if (activationKey === startKey) return;
    activationKey = startKey;
    activationDebug("start-attempt", {
      phase: room.round?.phase || null,
      roundNumber,
      cycleNumber,
      turnNumber,
      hasParent: Boolean(room.parentUid),
      currentUserInPlayers: Boolean(room.players?.[user.uid]),
      currentUserIsHost: room.hostUid === user.uid,
      seatCount: Array.isArray(room.seats) ? room.seats.length : 0,
      allConnected: allPlayersConnected(room),
      preparationStatuses: Array.isArray(room.seats) ? room.seats.map(uid => preparationStatus(uid)) : []
    });
    try {
      const firstParentUid = room.seats[0];
      await update(ref(database, roomPath(roomId)), {
        parentUid: firstParentUid,
        "round/turnNumber": 1
      });
      const activatedRoom = (await get(ref(database, roomPath(roomId)))).val();
      activationDebug("start-result", {
        committed: activatedRoom?.parentUid === firstParentUid && Number(activatedRoom?.round?.turnNumber) === 1,
        resultingTurnNumber: Number(activatedRoom?.round?.turnNumber) || 0,
        resultingHasParent: Boolean(activatedRoom?.parentUid)
      });
    } catch (error) {
      const activatedRoom = (await get(ref(database, roomPath(roomId))).catch(() => null))?.val?.();
      if (activatedRoom?.parentUid === activatedRoom?.seats?.[0] && Number(activatedRoom?.round?.turnNumber) === 1) {
        activationDebug("start-result", {
          committed: true,
          resultingTurnNumber: 1,
          resultingHasParent: true,
          completedByAnotherClient: true
        });
        return;
      }
      hideDiscussionIntro();
      activationDebug("start-error", { code: error?.code || null, message: error?.message || String(error) });
      console.warn("一番手を開始できませんでした。", error);
      setRoundMessage(`一番手を開始できませんでした。${error.message || ""}`);
    } finally {
      activationKey = "";
    }
    return;
  }
  if (room.parentUid !== user.uid) return;
  const key = `${roomId}:${roundNumber}:${room.parentUid}`;
  if (activationKey === key) return;
  activationKey = key;
  try {
    const preparation = (await get(ref(database, privatePreparationPath(roomId, cycleNumber, user.uid)))).val();
    const parentIndex = Number(preparation?.parentCandidateIndex);
    if (!preparation
      || preparation.status !== "complete"
      || !preparation.cardId
      || !preparation.cardImage
      || !Array.isArray(preparation.officialWords)
      || preparation.officialWords.length !== 3
      || !Array.isArray(preparation.publicWords)
      || preparation.publicWords.length !== 4
      || !Number.isInteger(parentIndex)
      || parentIndex < 0
      || parentIndex > 3) return;
    const secret = {
      officialWords: preparation.officialWords,
      cardId: preparation.cardId,
      createdAt: Number(preparation.createdAt) || Date.now(),
      parentWord: preparation.parentWord,
      parentWordConfirmedAt: Number(preparation.parentWordConfirmedAt) || Date.now(),
      publicWords: preparation.publicWords,
      parentCandidateIndex: parentIndex
    };
    await set(ref(database, roundSecretPath(roomId, roundNumber, user.uid)), secret);
    const fresh = (await get(ref(database, roomPath(roomId)))).val();
    if (!fresh || fresh.round?.phase !== "draw" || fresh.parentUid !== user.uid || Number(fresh.round?.number) !== roundNumber) return;
    const usedCardIds = { ...(fresh.round?.usedCardIds || {}), [String(preparation.cardId)]: true };
    await update(ref(database, `${roomPath(roomId)}/round`), {
      phase: "parent-word",
      cardId: preparation.cardId,
      cardImage: preparation.cardImage,
      usedCardIds
    });
    const discussionDurationSeconds = Number(fresh.discussionMinutes) * 60;
    if (!Number.isInteger(discussionDurationSeconds) || discussionDurationSeconds <= 0) throw Error("推理時間を確認できませんでした。");
    await update(ref(database, `${roomPath(roomId)}/round`), {
      phase: "discussion",
      publicWords: preparation.publicWords,
      discussionStartedAt: serverTimestamp(),
      discussionDurationSeconds
    });
  } catch (error) {
    console.warn("仕込み済みの番手を開始できませんでした。", error);
    if (latestRoom?.round?.phase === "draw") setRoundMessage(`番手を開始できませんでした。${error.message || ""}`);
  } finally {
    activationKey = "";
  }
}

function subscribeOwnPreparation(room) {
  if (!user?.uid || room?.status !== "started") return;
  const { cycleNumber } = turnInfo(room);
  const key = `${roomId}:${cycleNumber}:${user.uid}`;
  if (preparationSubscriptionKey === key) return;
  preparationUnsubscribe?.();
  preparationUnsubscribe = null;
  preparationSubscriptionKey = key;
  ownPreparation = null;
  preparationUnsubscribe = onValue(ref(database, privatePreparationPath(roomId, cycleNumber, user.uid)), snapshot => {
    if (preparationSubscriptionKey !== key) return;
    ownPreparation = snapshot.val();
    void restoreOwnPresenceStatus();
    if (isPreparationPhase(latestRoom)) requestAnimationFrame(() => renderPreparation(latestRoom));
    void maybeActivatePreparedTurn(latestRoom);
  }, error => console.warn("仕込み情報を復元できませんでした。", error));
}

function subscribePreparationProgress(room) {
  if (!roomId || room?.status !== "started") return;
  const { cycleNumber } = turnInfo(room);
  const key = `${roomId}:${cycleNumber}`;
  if (progressSubscriptionKey === key) return;
  progressUnsubscribe?.();
  progressUnsubscribe = null;
  progressSubscriptionKey = key;
  preparationProgress = {};
  progressUnsubscribe = onValue(ref(database, preparationProgressPath(roomId, cycleNumber)), snapshot => {
    if (progressSubscriptionKey !== key) return;
    preparationProgress = snapshot.val() || {};
    syncDiscussionIntro(latestRoom);
    if (isPreparationPhase(latestRoom)) requestAnimationFrame(() => renderPreparation(latestRoom));
    void maybeActivatePreparedTurn(latestRoom);
  }, error => console.warn("一斉仕込みの進捗を受信できませんでした。", error));
}

function patchHistoryLabels() {
  const list = $("#history-list");
  if (!list || !latestRoom?.seats?.length) return;
  const records = Object.values(multiplayerHistory || {}).sort((a, b) => Number(b.round) - Number(a.round));
  const headings = [...list.querySelectorAll(".history-entry h3")];
  records.forEach((record, index) => {
    const roundNumber = Number(record.round) || 1;
    const count = latestRoom.seats.length;
    const cycleNumber = Math.floor((roundNumber - 1) / count) + 1;
    const turnNumber = ((roundNumber - 1) % count) + 1;
    if (headings[index]) headings[index].textContent = `${seatLabel(cycleNumber)}　${turnLabel(turnNumber)}`;
  });
}

function wrapHistoryRenderer() {
  if (historyWrapped || !window.multiplayerPhase1?.renderHistory) return;
  const original = window.multiplayerPhase1.renderHistory;
  window.multiplayerPhase1.renderHistory = (...args) => {
    const result = original(...args);
    requestAnimationFrame(patchHistoryLabels);
    return result;
  };
  historyWrapped = true;
}

function subscribeHistory(id) {
  historyUnsubscribe?.();
  multiplayerHistory = {};
  historyUnsubscribe = onValue(ref(database, historyPath(id)), snapshot => {
    multiplayerHistory = snapshot.val() || {};
    patchHistoryLabels();
  }, () => {});
}

function handleRoom(room) {
  latestRoom = room;
  syncDiscussionIntro(room);
  if (!room || room.status !== "started" || room.endedBy) return;
  subscribePreparationProgress(room);
  subscribeOwnPreparation(room);
  wrapHistoryRenderer();
  if (isPreparationPhase(room)) {
    void restoreOwnPresenceStatus();
    requestAnimationFrame(() => {
      if (isPreparationPhase(latestRoom)) renderPreparation(latestRoom);
    });
    void maybeActivatePreparedTurn(room);
    return;
  }
  requestAnimationFrame(() => patchActivePhase(room));
  if (room.round?.phase === "draw") void maybeActivatePreparedTurn(room);
}

function detachRoom() {
  roomUnsubscribe?.();
  presenceUnsubscribe?.();
  progressUnsubscribe?.();
  preparationUnsubscribe?.();
  historyUnsubscribe?.();
  roomUnsubscribe = null;
  presenceUnsubscribe = null;
  progressUnsubscribe = null;
  preparationUnsubscribe = null;
  historyUnsubscribe = null;
  roomId = "";
  latestRoom = null;
  roomPresence = {};
  preparationProgress = {};
  ownPreparation = null;
  multiplayerHistory = {};
  preparationSubscriptionKey = "";
  progressSubscriptionKey = "";
  activationKey = "";
  editingKey = "";
  completedDiscussionIntros.clear();
  hideDiscussionIntro();
  window.multiplayerPhase1?.clearRoundChrome?.();
}

async function attachFromStoredSession() {
  if (attachPending) return;
  const session = storedSession();
  if (!session?.roomId) {
    if (roomId) detachRoom();
    return;
  }
  if (roomId === session.roomId && roomUnsubscribe) return;
  attachPending = true;
  try {
    const context = await getFirebaseContext();
    if (context.user.uid !== session.uid) return;
    if (roomId && roomId !== session.roomId) detachRoom();
    database = context.database;
    user = context.user;
    roomId = session.roomId;
    roomUnsubscribe = onValue(ref(database, roomPath(roomId)), snapshot => {
      if (roomId !== session.roomId) return;
      handleRoom(snapshot.val());
    }, error => console.warn("一斉仕込み用の宴情報を受信できませんでした。", error));
    presenceUnsubscribe = onValue(ref(database, presencePath(roomId)), snapshot => {
      if (roomId !== session.roomId) return;
      roomPresence = snapshot.val() || {};
      syncDiscussionIntro(latestRoom);
      if (isPreparationPhase(latestRoom)) requestAnimationFrame(() => renderPreparation(latestRoom));
      else requestAnimationFrame(() => patchActivePhase(latestRoom));
      void maybeActivatePreparedTurn(latestRoom);
    }, error => console.warn("一斉仕込み用の接続状態を受信できませんでした。", error));
    subscribeHistory(roomId);
  } catch (error) {
    console.warn("一斉仕込み機能を開始できませんでした。", error);
  } finally {
    attachPending = false;
  }
}

setInterval(() => { void attachFromStoredSession(); }, ATTACH_INTERVAL_MS);
void attachFromStoredSession();
