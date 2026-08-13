import { getFirebaseContext } from "./firebase-client.js";
import { get, onValue, ref, update } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

const ROOM_PREFIX = "rooms";
const NAME_STORAGE_KEY = "board-game:dev:multiplayer-name";
let catalog = [];
let roomId = "";
let roomUnsubscribe = null;
let latestRoom = null;
let currentUser = null;
let openedRoom = false;

const $ = selector => document.querySelector(selector);
const roomPath = id => `${ROOM_PREFIX}/${id}`;
const show = name => document.querySelectorAll("[data-screen]").forEach(screen => screen.classList.toggle("is-hidden", screen.dataset.screen !== name));
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character]));
const normalizedName = name => name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
const savedName = () => localStorage.getItem(NAME_STORAGE_KEY) || "";
const saveName = name => localStorage.setItem(NAME_STORAGE_KEY, name);
const enabled = () => /\/board-game\/dev(?:\/|$)/.test(location.pathname);

async function ensureCatalog() {
  if (catalog.length) return catalog;
  const listing = await (await fetch("card-sets.json")).json();
  catalog = await Promise.all(listing.cardSetIds.map(async id => await (await fetch(`cards/${id}/cards.json`)).json()));
  return catalog;
}

function setOptions(select, items, selected) {
  select.replaceChildren(...items.map(item => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    return option;
  }));
  select.value = selected || items[0]?.id || "";
}

async function openCreate() {
  show("create-room");
  $("#host-name").value = savedName() || "客人1";
  $("#host-discussion-time").value = "2";
  try {
    const sets = await ensureCatalog();
    setOptions($("#host-card-set"), sets, sets[0]?.id);
    refreshHostWordSets();
  } catch (error) { $("#create-room-error").textContent = `設定を読み込めませんでした。${error.message || ""}`; }
}

function refreshHostWordSets() {
  const selected = catalog.find(set => set.id === $("#host-card-set").value);
  setOptions($("#host-word-set"), selected?.wordSets || [], selected?.wordSets?.[0]?.id);
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(value => alphabet[value % alphabet.length]).join("");
}

function inviteUrl(id) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("room", id);
  return url.toString();
}

function playerEntries(room) { return Object.entries(room?.players || {}).map(([uid, player]) => ({ uid, ...player })); }

function renderPlayerBar(room) {
  const bar = $("#multiplayer-player-bar");
  if (!room?.seats) { bar.classList.add("is-hidden"); return; }
  const entries = playerEntries(room);
  bar.innerHTML = room.seats.map((uid, index) => {
    const player = entries.find(item => item.uid === uid) || { name: "不明" };
    return `<div class="multiplayer-player${uid === room.parentUid ? " is-parent" : ""}"><strong>${uid === room.parentUid ? "親　" : ""}${escape(player.name)}</strong><span>0点</span><small>${uid === currentUser?.uid ? "あなた" : "待機中"}</small></div>`;
  }).join("");
  bar.classList.remove("is-hidden");
}

async function renderWaiting(room) {
  latestRoom = room;
  if (!room) { $("#room-waiting-message").textContent = "この宴は見つかりません。"; return; }
  const entries = playerEntries(room);
  const isHost = openedRoom && room.hostUid === currentUser?.uid;
  const discussionMinutes = room.discussionMinutes;
  $("#room-summary").innerHTML = `<p class="room-number-row"><strong>部屋番号：${escape(roomId)}</strong><button id="copy-room-id" class="copy-icon-button" type="button" aria-label="部屋番号をコピー" title="部屋番号をコピー"><span aria-hidden="true">⧉</span></button></p><p>カードセット：${escape(room.cardSetName)}</p><p>ワードセット：${escape(room.wordSetName)}</p><p>推理時間：${escape(discussionMinutes)}分</p>`;
  $("#room-players").innerHTML = entries.length ? entries.sort((a,b) => a.joinedAt - b.joinedAt).map(player => `<div class="player-item"><span>${escape(player.name)}${player.uid === room.hostUid ? "（主催）" : ""}</span></div>`).join("") : "";
  $("#room-waiting-message").textContent = room.status === "waiting" ? `参加者 ${entries.length}人／2〜6人で開始できます。` : room.status === "closed" ? "主催者が宴を閉じました。" : "宴を開始しました。";
  $("#room-invitation").classList.toggle("is-hidden", !isHost || room.status !== "waiting");
  const startButton = $("#start-multiplayer-game");
  const canStart = entries.length >= 2 && entries.length <= 6 && room.status === "waiting";
  const showStartButton = isHost && room.status === "waiting";
  startButton.hidden = !showStartButton;
  startButton.classList.toggle("is-hidden", !showStartButton);
  startButton.disabled = !canStart;
  startButton.classList.toggle("button-primary", canStart);
  startButton.classList.toggle("button-secondary", !canStart);
  if (isHost) {
    const url = inviteUrl(roomId);
    $("#invite-url").value = url;
    const qr = $("#invite-qr");
    qr.replaceChildren();
    const canvas = document.createElement("canvas");
    qr.append(canvas);
    await QRCode.toCanvas(canvas, url, { width: 180, margin: 1, color: { dark: "#063b2b", light: "#fffdf4" } });
  }
  if (room.status === "started") enterDrawScreen(room);
}

function enterDrawScreen(room) {
  const isParent = room.parentUid === currentUser?.uid;
  renderPlayerBar(room);
  $("#round-title").textContent = `親：${playerEntries(room).find(player => player.uid === room.parentUid)?.name || ""}`;
  $("#round-card-message").textContent = isParent ? "あなたが親です。次のフェーズで札を引けるようになります。" : "親が札を選んでいます。お待ちください。";
  $("#round-start-button").disabled = true;
  $("#draw-card").textContent = isParent ? "札選びは次のフェーズで開始します" : "親を待っています";
  $("#deck-stack-image").onclick = null;
  $("#deck-stack-image").onkeydown = null;
  $("#round-start-button").onclick = null;
  show("round");
}

function subscribeRoom(id) {
  roomUnsubscribe?.();
  roomUnsubscribe = onValue(ref((window.__firebaseDatabase), roomPath(id)), snapshot => renderWaiting(snapshot.val()));
}

function clearInviteUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has("room")) return;
  url.searchParams.delete("room");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearRoomSession() {
  roomUnsubscribe?.();
  roomUnsubscribe = null;
  latestRoom = null;
  roomId = "";
  openedRoom = false;
}

async function removeCurrentPlayer() {
  if (!roomId || !currentUser || !window.__firebaseDatabase) return;
  const player = latestRoom?.players?.[currentUser.uid];
  const nameKey = player?.nameKey || normalizedName(savedName());
  await update(ref(window.__firebaseDatabase, roomPath(roomId)), {
    [`players/${currentUser.uid}`]: null,
    [`nameIndex/${nameKey}`]: null
  });
}

async function createRoom() {
  const error = $("#create-room-error");
  error.textContent = "";
  const name = $("#host-name").value.trim();
  if (!name) { error.textContent = "客人名を入力してください。"; return; }
  const cardSet = catalog.find(set => set.id === $("#host-card-set").value);
  const wordSet = cardSet?.wordSets?.find(set => set.id === $("#host-word-set").value);
  if (!cardSet || !wordSet) { error.textContent = "カードセットとワードセットを選択してください。"; return; }
  const context = await getFirebaseContext();
  currentUser = context.user;
  window.__firebaseDatabase = context.database;
  openedRoom = true;
  roomId = makeRoomId();
  const key = normalizedName(name);
  const room = {
    hostUid: context.user.uid, status: "waiting", createdAt: Date.now(),
    cardSet: cardSet.id, cardSetName: cardSet.name, wordSet: wordSet.id, wordSetName: wordSet.name,
    discussionMinutes: Number($("#host-discussion-time").value),
    players: { [context.user.uid]: { name, nameKey: key, joinedAt: Date.now() } },
    nameIndex: { [key]: context.user.uid }
  };
  try { await update(ref(context.database, roomPath(roomId)), room); saveName(name); subscribeRoom(roomId); show("multiplayer-waiting"); }
  catch (cause) { error.textContent = `部屋を作成できませんでした。${cause.message || ""}`; }
}

async function joinRoom() {
  const error = $("#join-room-error"); error.textContent = "";
  const id = $("#join-room-id").value.trim().toUpperCase();
  const name = $("#join-name").value.trim();
  if (!id || !name) { error.textContent = "部屋番号と客人名を入力してください。"; return; }
  const context = await getFirebaseContext();
  currentUser = context.user; window.__firebaseDatabase = context.database; openedRoom = false;
  const snapshot = await get(ref(context.database, roomPath(id)));
  const room = snapshot.val();
  if (!room) { error.textContent = "部屋番号が見つかりません。"; return; }
  if (room.status !== "waiting") { error.textContent = room.status === "closed" ? "この宴は主催者により閉じられました。" : "この宴はすでに開始されています。"; return; }
  if (playerEntries(room).length >= 6) { error.textContent = "この宴は満席です。"; return; }
  const key = normalizedName(name);
  if (room.nameIndex?.[key] && room.nameIndex[key] !== context.user.uid) { error.textContent = "同じ名前の客人がすでに参加しています。別の名前を入力してください。"; return; }
  try {
    await update(ref(context.database, roomPath(id)), {
      [`players/${context.user.uid}`]: { name, nameKey: key, joinedAt: Date.now() },
      [`nameIndex/${key}`]: context.user.uid
    });
  } catch (cause) {
    error.textContent = "同じ名前の客人がすでに参加しています。別の名前を入力してください。";
    return;
  }
  roomId = id; saveName(name); subscribeRoom(roomId); show("multiplayer-waiting");
}

async function startRoom() {
  if (!openedRoom || !latestRoom || latestRoom.hostUid !== currentUser?.uid) return;
  const players = playerEntries(latestRoom);
  if (players.length < 2 || players.length > 6) return;
  const seats = [...players.map(player => player.uid)];
  for (let index = seats.length - 1; index > 0; index--) { const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1); [seats[index], seats[other]] = [seats[other], seats[index]]; }
  await update(ref(window.__firebaseDatabase, roomPath(roomId)), { status: "started", startedAt: Date.now(), seats, parentUid: seats[0] });
}

async function leaveWaitingRoom() {
  if (openedRoom && latestRoom?.hostUid === currentUser?.uid && latestRoom.status === "waiting") {
    try {
      await update(ref(window.__firebaseDatabase, roomPath(roomId)), { status: "closed", closedAt: Date.now() });
    } catch (cause) {
      $("#room-waiting-message").textContent = `宴を閉じられませんでした。${cause.message || ""}`;
      return;
    }
    clearRoomSession();
    openCreate();
    return;
  }
  try {
    await removeCurrentPlayer();
  } catch (cause) {
    $("#room-waiting-message").textContent = `宴から退出できませんでした。${cause.message || ""}`;
    return;
  }
  clearRoomSession();
  clearInviteUrl();
  show("title");
}

function openJoinFromUrl() {
  const id = new URLSearchParams(location.search).get("room");
  if (!id) return false;
  $("#join-room-id").value = id.toUpperCase();
  $("#join-name").value = savedName() || "客人";
  show("join-room");
  return true;
}

function initialize() {
  if (!enabled()) return;
  const style = document.createElement("style");
  style.textContent = ".multiplayer-choice-image{max-width:330px;margin:12px auto 18px}.multiplayer-choice-buttons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.multiplayer-choice-buttons .button{width:100%;padding-inline:8px}.multiplayer-choice-back{margin-top:24px}.copy-field{display:flex;gap:8px;align-items:stretch}.copy-field input{min-width:0;flex:1}.copy-icon-button{flex:0 0 42px;width:42px;min-height:42px;border:0;border-radius:11px;background:#eceff1;color:#263238;font-size:1.3rem;line-height:1;display:grid;place-items:center;cursor:pointer}.room-number-row{display:flex;align-items:center;gap:8px}.room-number-row .copy-icon-button{flex-basis:34px;width:34px;min-height:34px;font-size:1.05rem}.multiplayer-summary{margin:14px 0;padding:12px;border:1px solid #68775c;border-radius:12px;background:#192623}.multiplayer-summary p{margin:5px 0}.invite-qr{display:grid;place-items:center;margin:12px auto}.invite-qr canvas{max-width:100%;height:auto;border-radius:8px}.multiplayer-player-bar{position:fixed;z-index:1500;top:0;left:0;right:0;display:flex;gap:5px;overflow-x:auto;padding:5px;background:#0d1c18ef;border-bottom:1px solid #68775c}.multiplayer-player{flex:0 0 min(130px,30vw);display:grid;gap:1px;padding:5px 7px;border:1px solid #46534d;border-radius:8px;color:#eee8dc;background:#192623;font-size:.72rem}.multiplayer-player.is-parent{border-color:#d39a55}.multiplayer-player strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.multiplayer-player small{color:#c2c1b5}.multiplayer-player-bar:not(.is-hidden)~.app-shell{padding-top:66px}";
  document.head.append(style);
  $("#single-device-mode").onclick = () => window.startSingleDeviceGame?.();
  $("#multiplayer-mode").onclick = () => show("multiplayer-role");
  $("#mode-choice-back").onclick = () => show("title");
  $("#create-room-choice").onclick = openCreate;
  $("#join-room-choice").onclick = () => { $("#join-room-id").value = ""; $("#join-name").value = savedName() || "客人"; show("join-room"); };
  $("#multiplayer-role-back").onclick = () => show("mode-choice");
  $("#create-room-back").onclick = () => show("multiplayer-role");
  $("#join-room-back").onclick = () => { clearInviteUrl(); show("multiplayer-role"); };
  $("#host-card-set").onchange = refreshHostWordSets;
  $("#create-room-button").onclick = createRoom;
  $("#join-room-button").onclick = joinRoom;
  $("#start-multiplayer-game").onclick = startRoom;
  $("#waiting-back").onclick = leaveWaitingRoom;
  const copyWithNotice = async value => { await navigator.clipboard.writeText(value); $("#room-waiting-message").textContent = "コピーしました。"; setTimeout(() => { if (latestRoom?.status === "waiting") $("#room-waiting-message").textContent = `参加者 ${playerEntries(latestRoom).length}人／2〜6人で開始できます。`; }, 1500); };
  $("#copy-invite-url").onclick = () => copyWithNotice($("#invite-url").value);
  document.addEventListener("click", event => { if (event.target.closest("#copy-room-id")) copyWithNotice(roomId); });
  window.addEventListener("beforeunload", event => {
    if (!roomId || !latestRoom || latestRoom.status === "closed") return;
    event.preventDefault();
    event.returnValue = "";
  });
}

window.multiplayerPhase1 = { isEnabled: enabled, openModeChoice: () => show("mode-choice"), openJoinFromUrl };
initialize();
