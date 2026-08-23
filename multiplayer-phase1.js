import { getFirebaseContext } from "./firebase-client.js";
import { get, onDisconnect, onValue, push, ref, remove, runTransaction, serverTimestamp, set, update } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
import { scoreRound } from "./game-rules.js";

const ROOM_PREFIX = "rooms";
const NAME_STORAGE_KEY = "board-game:dev:multiplayer-name";
const ROOM_SESSION_STORAGE_KEY = "board-game:dev:multiplayer-room-session";
const ROOM_AUTO_RESUME_SUPPRESSED_STORAGE_KEY = "board-game:dev:multiplayer-auto-resume-suppressed";
const RESUME_DEBUG_LOG_STORAGE_KEY = "board-game:dev:multiplayer-resume-debug-log";
const RESUME_DEBUG_LOG_LIMIT = 80;
const LEAVE_RETRY_COUNT = 3;
const LEAVE_RETRY_DELAY_MS = 700;
const CONNECTION_TIMEOUT_MS = 8000;
let catalog = [];
let roomId = "";
let roomUnsubscribe = null;
let latestRoom = null;
let currentUser = null;
let openedRoom = false;
let leavingWaitingRoom = false;
let startingRoom = false;
let presenceUnsubscribe = null;
let roomPresenceUnsubscribe = null;
let roomPresence = {};
let activeConnectionRef = null;
let secretUnsubscribe = null;
let secretSubscriptionKey = "";
let parentSecret = null;
let discussionTimer = null;
let discussionTimerRound = "";
let serverTimeOffset = 0;
let serverTimeOffsetUnsubscribe = null;
let serverTimeOffsetRetryUnsubscribe = null;
let serverTimeOffsetDatabase = null;
let serverTimeOffsetReady = false;
let serverTimeOffsetReadyPromise = null;
let resolveServerTimeOffsetReady = null;
let rejectServerTimeOffsetReady = null;
let serverTimeOffsetGeneration = 0;
let progressUnsubscribe = null;
let progressSubscriptionKey = "";
let roundProgress = {};
let answerUnsubscribe = null;
let answerSubscriptionKey = "";
let answerSummaryUnsubscribe = null;
let answerSummarySubscriptionKey = "";
let ownAnswer = null;
let selectedCandidateIndex = null;
let resultRouletteKey = "";
let resultClockWaitKey = "";
let resultClockWaitGeneration = 0;
let resultVisibilityHandler = null;
let resultCompletionTimer = null;
let resultCompletionTimerKey = "";
let resultPresentationCompletedKey = "";
let phaseTransitionPending = false;
let observedRoundKey = "";
let parentWordError = "";
let parentWordErrorKey = "";
let storedResumeAvailable = false;
let storedSessionReconnectUnsubscribe = null;
let storedSessionReconnectAttempted = false;
let checkingStoredRoomSession = false;
let setupMode = "single";
let multiplayerSetupMode = "host";
let multiplayerModeSelectedInCurrentSetup = false;
let historyUnsubscribe = null;
let historySubscriptionKey = "";
let multiplayerHistory = {};
let multiplayerFinalKey = "";
let multiplayerFinalCardsKey = "";
let multiplayerFinalPresentationKey = "";

const $ = selector => document.querySelector(selector);
const roomPath = id => `${ROOM_PREFIX}/${id}`;
const roomPresencePath = id => `roomPresence/${id}`;
const secretPath = (id, roundNumber, uid) => `roomSecrets/${id}/rounds/${roundNumber}/${uid}`;
const progressPath = (id, roundNumber) => `roomProgress/${id}/rounds/${roundNumber}`;
const answerRoundPath = (id, roundNumber) => `roomAnswers/${id}/rounds/${roundNumber}`;
const answerPath = (id, roundNumber, uid) => `${answerRoundPath(id, roundNumber)}/${uid}`;
const historyPath = id => `roomHistories/${id}`;
const parentWordErrorKeyFor = room => `${roomId}:${currentRoundNumber(room)}:${room?.round?.cardId ?? ""}`;
function setParentWordError(room, message) {
  parentWordErrorKey = parentWordErrorKeyFor(room);
  parentWordError = message;
  $("#parent-error").textContent = message;
}
function clearParentWordError() {
  parentWordError = "";
  parentWordErrorKey = "";
  $("#parent-error").textContent = "";
}
const show = name => {
  if (window.showGameScreen) { window.showGameScreen(name); return; }
  document.querySelectorAll("[data-screen]").forEach(screen => screen.classList.toggle("is-hidden", screen.dataset.screen !== name));
};
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[character]));
const normalizedName = name => name.trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
const savedName = () => localStorage.getItem(NAME_STORAGE_KEY) || "";
const saveName = name => localStorage.setItem(NAME_STORAGE_KEY, name);
const enabled = () => /\/board-game\/dev(?:\/|$)/.test(location.pathname);
const storedRoomSession=()=>{try{const s=JSON.parse(localStorage.getItem(ROOM_SESSION_STORAGE_KEY)||"null");return s&&typeof s==="object"?s:null;}catch{return null;}};
const saveRoomSession=room=>{if(!roomId||!currentUser?.uid||!room?.feastId)return;localStorage.setItem(ROOM_SESSION_STORAGE_KEY,JSON.stringify({roomId,uid:currentUser.uid,name:room.players?.[currentUser.uid]?.name||savedName(),role:room.hostUid===currentUser.uid?"host":"guest",feastId:room.feastId}));};
const forgetRoomSession=()=>localStorage.removeItem(ROOM_SESSION_STORAGE_KEY);
const autoResumeSuppressed=()=>localStorage.getItem(ROOM_AUTO_RESUME_SUPPRESSED_STORAGE_KEY)==="true";
const suppressAutoResume=()=>localStorage.setItem(ROOM_AUTO_RESUME_SUPPRESSED_STORAGE_KEY,"true");
const allowAutoResume=()=>localStorage.removeItem(ROOM_AUTO_RESUME_SUPPRESSED_STORAGE_KEY);
function resumeDebug(event, detail={}) {
  if (!enabled()) return;
  try {
    const entries=JSON.parse(localStorage.getItem(RESUME_DEBUG_LOG_STORAGE_KEY)||"[]");
    const log=Array.isArray(entries)?entries:[];
    log.push({at:new Date().toISOString(),event,detail});
    localStorage.setItem(RESUME_DEBUG_LOG_STORAGE_KEY,JSON.stringify(log.slice(-RESUME_DEBUG_LOG_LIMIT)));
    const button=$("#multiplayer-resume-debug");
    if(button)button.hidden=false;
  } catch (error) { console.warn("復帰診断ログを保存できませんでした。",error); }
}
function resumeDebugEntries() {
  try { const entries=JSON.parse(localStorage.getItem(RESUME_DEBUG_LOG_STORAGE_KEY)||"[]"); return Array.isArray(entries)?entries:[]; }
  catch { return []; }
}
function showResumeDebugLog() {
  const output=resumeDebugEntries().map(entry=>`${entry.at} ${entry.event} ${JSON.stringify(entry.detail)}`).join("\n")||"診断ログはありません。";
  $("#multiplayer-debug-actions")?.remove();
  $("#recovery-title").textContent="復帰診断ログ";
  const pre=Object.assign(document.createElement("pre"),{className:"multiplayer-debug-log",textContent:output});
  $("#recovery-message").replaceChildren(pre);
  $("#recovery-resume").hidden=true; $("#recovery-retry").hidden=true; $("#recovery-exit").hidden=true;
  const actions=document.createElement("div"); actions.id="multiplayer-debug-actions"; actions.className="button-row";
  const copy=Object.assign(document.createElement("button"),{className:"button button-primary",type:"button",textContent:"ログをコピー"});
  copy.onclick=async()=>{await navigator.clipboard.writeText(output);copy.textContent="コピーしました";};
  const clear=Object.assign(document.createElement("button"),{className:"button button-secondary",type:"button",textContent:"ログを消去"});
  clear.onclick=()=>{localStorage.removeItem(RESUME_DEBUG_LOG_STORAGE_KEY);showResumeDebugLog();};
  actions.append(copy,clear); $("#recovery-message").after(actions); show("multiplayer-recovery");
}
const roomEnded=room=>Boolean(room?.endedBy);
const withRoomPresence=room=>room?{...room,presence:roomPresence}:room;
function applyRoomPresence(value) {
  roomPresence = value || {};
  resumeDebug("presence:room-observed", {
    connectedPlayers: Object.values(roomPresence).filter(connections => Object.keys(connections || {}).length > 0).length,
    ownConnections: Object.keys(roomPresence[currentUser?.uid] || {}).length
  });
  if (!latestRoom) return;
  renderWaiting(withRoomPresence(latestRoom)).catch(error => {
    show("multiplayer-waiting");
    $("#room-waiting-message").textContent = `宴の状態を表示できませんでした。${error.message || ""}`;
  });
}
async function refreshRoomPresence(id) {
  const snapshot = await get(ref(window.__firebaseDatabase, roomPresencePath(id)));
  resumeDebug("presence:room-read", {
    connectedPlayers: Object.values(snapshot.val() || {}).filter(connections => Object.keys(connections || {}).length > 0).length,
    ownConnections: Object.keys(snapshot.val()?.[currentUser?.uid] || {}).length
  });
  if (roomId === id) applyRoomPresence(snapshot.val());
}
async function getCurrentRoomWithPresence() {
  const [roomSnapshot, presenceSnapshot] = await Promise.all([
    get(ref(window.__firebaseDatabase, roomPath(roomId))),
    get(ref(window.__firebaseDatabase, roomPresencePath(roomId)))
  ]);
  const room = roomSnapshot.val();
  return room ? { ...room, presence: presenceSnapshot.val() || {} } : null;
}
const disconnectedPlayers=room=>playerEntries(room).filter(player=>!Object.keys(room?.presence?.[player.uid]||{}).length);
function waitForDatabaseConnection(database, timeoutMs=CONNECTION_TIMEOUT_MS){
  if(!navigator.onLine)return Promise.reject(Error("オフラインのため、通信に接続してから参加してください。"));
  return new Promise((resolve,reject)=>{
    let settled=false;
    let unsubscribe=()=>{};
    const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);unsubscribe();callback(value);};
    const timer=setTimeout(()=>finish(reject,Error("Firebaseへ接続できません。通信状態を確認してください。")),timeoutMs);
    unsubscribe=onValue(ref(database,".info/connected"),snapshot=>{
      if(snapshot.val()===true)finish(resolve);
    },error=>finish(reject,error));
  });
}
async function verifyJoinedRoom(id,uid,nameKey){
  const [roomSnapshot,presenceSnapshot]=await Promise.all([
    get(ref(window.__firebaseDatabase,roomPath(id))),
    get(ref(window.__firebaseDatabase,`${roomPresencePath(id)}/${uid}`))
  ]);
  const room=roomSnapshot.val();
  if(((room?.status==="waiting"&&joinSlotForUid(room,uid)?.nameKey===nameKey)||(room?.status==="started"&&room.players?.[uid]?.nameKey===nameKey&&room.nameIndex?.[nameKey]===uid))&&presenceSnapshot.exists())return {...room,presence:{[uid]:presenceSnapshot.val()}};
  throw Error("参加状態を確認できません。");
}

function stopPresence(){presenceUnsubscribe?.();presenceUnsubscribe=null;if(activeConnectionRef){onDisconnect(activeConnectionRef).cancel().catch(()=>{});remove(activeConnectionRef).catch(()=>{});activeConnectionRef=null;}}
function startPresence() {
  if (!window.__firebaseDatabase || !roomId || !currentUser?.uid) {
    return Promise.reject(Error("接続状態を開始できません。"));
  }
  stopPresence();
  const connections = ref(window.__firebaseDatabase, `${roomPresencePath(roomId)}/${currentUser.uid}`);
  return new Promise((resolve, reject) => {
    let first = true;
    let stage = "waiting-for-connection";
    const fail = error => {
      resumeDebug("presence:error", { stage, code: error?.code || null, message: error?.message || String(error) });
      if (!first) return;
      first = false;
      clearTimeout(timeout);
      presenceUnsubscribe?.();
      presenceUnsubscribe = null;
      reject(error);
    };
    const timeout = setTimeout(() => fail(Error("Firebaseへの再接続を待っています。")), CONNECTION_TIMEOUT_MS);
    presenceUnsubscribe = onValue(ref(window.__firebaseDatabase, ".info/connected"), async snapshot => {
      if (snapshot.val() !== true) {
        activeConnectionRef = null;
        return;
      }
      const connection = push(connections);
      try {
        stage = "register-on-disconnect";
        resumeDebug("presence:register-on-disconnect");
        await onDisconnect(connection).remove();
        stage = "write-connection";
        resumeDebug("presence:write-connection");
        await set(connection, true);
        await refreshRoomPresence(roomId);
        stage = "connected";
        resumeDebug("presence:connected");
        activeConnectionRef = connection;
        if (first) {
          first = false;
          clearTimeout(timeout);
          resolve();
        }
      } catch (error) {
        if (first) fail(error);
        else console.error("接続状態を再登録できませんでした。", error);
      }
    }, error => {
      stage = "listen-connection";
      fail(error);
    });
  });
}
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

function ensureMultiplayerName() {
  const input = $("#multiplayer-name");
  if (!input.value) input.value = savedName() || "客人";
}
async function prepareCreateForm() {
  ensureMultiplayerName();
  if (!$("#host-discussion-time").value) $("#host-discussion-time").value = "2";
  try {
    const sets = await ensureCatalog();
    setOptions($("#host-card-set"), sets, $("#host-card-set").value || sets[0]?.id);
    refreshHostWordSets();
  } catch (error) { $("#create-room-error").textContent = `設定を読み込めませんでした。${error.message || ""}`; }
}
function refreshHostWordSets() {
  const selected = catalog.find(set => set.id === $("#host-card-set").value);
  setOptions($("#host-word-set"), selected?.wordSets || [], $("#host-word-set").value || selected?.wordSets?.[0]?.id);
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

function joinSlotEntries(room) {
  if (room?.status !== "waiting") return [];
  return Object.entries(room?.joinSlots || {}).map(([slot, player]) => ({ slot, ...player }));
}
function joinSlotForUid(room, uid) {
  return joinSlotEntries(room).find(player => player.uid === uid) || null;
}
function playerEntries(room) {
  const players = Object.entries(room?.players || {}).map(([uid, player]) => ({ uid, ...player }));
  return room?.status === "waiting" ? [...players, ...joinSlotEntries(room)] : players;
}

let messageTickerFrame = 0;
let roundHeaderObserver = null;

function refreshMessageTicker() {
  const viewport = $("#multiplayer-message-bar");
  const track = $("#multiplayer-message-text");
  if (!viewport || !track) return;
  cancelAnimationFrame(messageTickerFrame);
  track.classList.remove("is-scrolling");
  track.style.removeProperty("--multiplayer-message-duration");
  track.style.removeProperty("--multiplayer-message-distance");
  track.style.removeProperty("--multiplayer-message-start");
  track.querySelectorAll("[data-ticker-copy]").forEach(copy => copy.remove());
  messageTickerFrame = requestAnimationFrame(() => {
    const primary = track.firstElementChild;
    if (!primary || primary.scrollWidth <= viewport.clientWidth + 1) return;
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
}

function updateRoundHeaderOffset() {
  const header = $("#multiplayer-round-header");
  const shell = $(".app-shell");
  if (!header || !shell || header.classList.contains("is-hidden")) return;
  shell.style.setProperty("--multiplayer-round-header-height", `${Math.ceil(header.getBoundingClientRect().height)}px`);
  refreshMessageTicker();
}

function roundTitleRow(screenName) {
  return $(`[data-screen="${screenName}"] .screen-title-row`) || $('#multiplayer-round-title-slot .screen-title-row');
}

function placeRoundTitleInHeader(screenName) {
  const slot = $("#multiplayer-round-title-slot");
  const previous = slot?.querySelector(".screen-title-row");
  if (previous && previous.dataset.multiplayerScreen) {
    $(`[data-screen="${previous.dataset.multiplayerScreen}"]`)?.prepend(previous);
  }
  const row = roundTitleRow(screenName);
  if (row && !row.dataset.multiplayerScreen) row.dataset.multiplayerScreen = screenName;
  if (slot && row && row.parentElement !== slot) slot.append(row);
}

function restoreRoundTitleToScreen() {
  const screen = $('[data-screen="round"]');
  const row = $('#multiplayer-round-title-slot .screen-title-row');
  const target = row?.dataset.multiplayerScreen ? $(`[data-screen="${row.dataset.multiplayerScreen}"]`) : screen;
  if (target && row && row.parentElement !== target) target.prepend(row);
}

function hideRoundHeader() {
  const header = $("#multiplayer-round-header");
  const shell = $(".app-shell");
  restoreRoundTitleToScreen();
  header?.classList.add("is-hidden");
  shell?.classList.remove("has-multiplayer-round-header");
  shell?.style.removeProperty("--multiplayer-round-header-height");
}

function setRoundMessage(message) {
  const track = $("#multiplayer-message-text");
  if (!track) return;
  const primary = document.createElement("span");
  primary.className = "multiplayer-message-copy";
  primary.textContent = message;
  track.replaceChildren(primary);
  refreshMessageTicker();
}

function playerPanelState(room, uid, disconnected) {
  if (roomEnded(room) && room.endedBy?.uid === uid) return { label: "退席", className: "is-complete" };
  if (disconnected.has(uid)) return { label: "切断中", className: "is-disconnected" };
  const phase = room?.round?.phase;
  const isParent = uid === room?.parentUid;
  if (phase === "draw" && isParent) return { label: "札選び中", className: "is-action-needed" };
  if (phase === "parent-word" && isParent) return { label: "ひそめ中", className: "is-action-needed" };
  if (phase === "discussion" && !isParent) return roundProgress?.discussion?.[uid] ? { label: "推理完了", className: "is-complete" } : { label: "推理中", className: "is-action-needed" };
  if (phase === "answer" && !isParent) return roundProgress?.answers?.[uid] ? { label: "完了", className: "is-complete" } : { label: "回答中", className: "is-action-needed" };
  if (phase === "reveal" && isParent) return { label: "開帳", className: "is-action-needed" };
  if (phase === "result" && isParent && resultPresentationFinished(room)) return { label: "得点確認", className: "is-action-needed" };
  if (phase === "score" && isParent) return { label: "次の席へ", className: "is-action-needed" };
  if (phase === "final" && room?.replayChoices?.[uid] === true) return { label: "再宴希望", className: "is-complete" };
  if (phase === "final") return { label: "確認中", className: "is-action-needed" };
  return { label: "", className: "" };
}
function renderPlayerBar(room, screenName="round") {
  const header=$("#multiplayer-round-header"),bar=$("#multiplayer-player-bar"),shell=$(".app-shell");
  if(!header||!bar||!shell||!room?.seats){hideRoundHeader();return;}
  const entries=playerEntries(room),disconnected=new Set(disconnectedPlayers(room).map(player=>player.uid));
  bar.innerHTML=room.seats.map(uid=>{
    const player=entries.find(item=>item.uid===uid)||{name:"不明"};
    const state=playerPanelState(room,uid,disconnected);
    const isParent = uid === room.parentUid;
    return `<div class="multiplayer-player${isParent?" is-parent":""}"><strong>${escape(player.name)}</strong><span class="multiplayer-player-score">${Number(player.score)||0}点</span>${isParent?'<b class="multiplayer-player-role">親</b>':""}<small class="${state.className}">${state.label}</small></div>`;
  }).join("");
  placeRoundTitleInHeader(screenName);
  header.classList.remove("is-hidden");shell.classList.add("has-multiplayer-round-header");updateRoundHeaderOffset();
}
async function renderWaiting(room) {
  latestRoom = room;
  if (room?.round?.phase !== "final") { multiplayerFinalKey = ""; multiplayerFinalCardsKey = ""; multiplayerFinalPresentationKey = ""; }
  if (leavingWaitingRoom) return;
  if (!room) { hideRoundHeader(); $("#room-waiting-message").textContent = "この宴は見つかりません。"; return; }
  if (room.status !== "started") {
    hideRoundHeader();
    if ($('[data-screen="round"]:not(.is-hidden)') || $('[data-screen="parent-input"]:not(.is-hidden)')) show("multiplayer-waiting");
  }
  const entries = playerEntries(room);
  const disconnected = new Set(disconnectedPlayers(room).map(player => player.uid));
  const allConnected = entries.length > 0 && disconnected.size === 0;
  const isHost = openedRoom && room.hostUid === currentUser?.uid;
  const discussionMinutes = room.discussionMinutes;
  $("#room-summary").innerHTML = `<p class="room-number-row"><strong>部屋番号：${escape(roomId)}</strong><button id="copy-room-id" class="copy-icon-button" type="button" aria-label="部屋番号をコピー" title="部屋番号をコピー"><span aria-hidden="true">⧉</span></button></p><p>カードセット：${escape(room.cardSetName)}</p><p>ワードセット：${escape(room.wordSetName)}</p><p>推理時間：${escape(discussionMinutes)}分</p>`;
  $("#room-players").innerHTML = entries.length ? entries.sort((a,b) => a.joinedAt - b.joinedAt).map(player => {
    const suffix = player.uid === room.hostUid
      ? (disconnected.has(player.uid) ? "（主催・切断）" : "（主催）")
      : (disconnected.has(player.uid) ? "（切断）" : "");
    return `<div class="player-item"><span>${escape(player.name)}${suffix}</span></div>`;
  }).join("") : "";
  const waitingMessage = room.status === "waiting"
    ? (allConnected ? `参加者 ${entries.length}人／2〜6人で開始できます。` : `参加者 ${entries.length}人／切断中の客人の復帰を待っています。`)
    : room.status === "closed" ? "主催者が宴を閉じました。" : "宴を開始しました。";
  $("#room-waiting-message").textContent = waitingMessage;
  $("#room-invitation").classList.toggle("is-hidden", !isHost || room.status !== "waiting");
  const startButton = $("#start-multiplayer-game");
  const canStart = entries.length >= 2 && entries.length <= 6 && allConnected && room.status === "waiting";
  const showStartButton = isHost && room.status === "waiting";
  startButton.hidden = !showStartButton;
  startButton.style.display = showStartButton ? "" : "none";
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
  if (room.status === "started") {
    subscribeHistory(room);
    const nextRoundKey=`${roomId}:${currentRoundNumber(room)}`;
    if(observedRoundKey&&observedRoundKey!==nextRoundKey)resetRoundLocalState();
    observedRoundKey=nextRoundKey;
    setSecretSubscription(room);
    setProgressSubscription(room);
    if (room.round?.phase === "discussion") enterDiscussionScreen(room);
    else if (room.round?.phase === "answer") enterAnswerScreen(room);
    else if (room.round?.phase === "reveal") enterRevealScreen(room);
    else if (room.round?.phase === "result") enterResultScreen(room);
    else if (room.round?.phase === "score") enterScoreScreen(room);
    else if (room.round?.phase === "final") enterMultiplayerFinalScreen(room);
    else if (room.round?.phase === "parent-word") enterParentWordScreen(room);
    else enterDrawScreen(room);
    reevaluateAutomaticTransition(room);
  }
}

function roundLabel(room) { return `第${["","一","二","三","四","五","六","七","八","九","十"][Number(room?.round?.number || 1)] || Number(room?.round?.number || 1)}席`; }
function roundLabelForNumber(roundNumber) { return `第${["","一","二","三","四","五","六","七","八","九","十"][Number(roundNumber)] || Number(roundNumber)}席`; }
function multiplayerCardMarkup(image) {
  return image ? `<img class="card-zoom-trigger" src="${escape(image)}" alt="お題カード。タップで拡大表示">` : `<div class="missing-card">カード画像を読み込めません</div>`;
}
function resultPresentationKey(room) {
  const round=room?.round||{};
  return `${roomId}:${currentRoundNumber(room)}:${String(round.revealCompletedAt)}:${JSON.stringify(round.roulettePlan||null)}`;
}
function resultPresentationFinished(room) {
  const round=room?.round||{}, plan=round.roulettePlan;
  const started=Number(round.revealCompletedAt), duration=Number(plan?.durationMs);
  const key=resultPresentationKey(room);
  if(resultPresentationCompletedKey===key)return true;
  const finished=Number.isFinite(started)&&started>0&&Number.isFinite(duration)&&duration>=0&&serverNow()>=started+duration;
  if(finished)resultPresentationCompletedKey=key;
  return finished;
}
function resultElapsedMs(room) {
  const started=Number(room?.round?.revealCompletedAt);
  return Number.isFinite(started)&&started>0 ? Math.max(0,serverNow()-started) : 0;
}
function stopResultVisibilitySync() {
  if(resultVisibilityHandler){document.removeEventListener("visibilitychange",resultVisibilityHandler);resultVisibilityHandler=null;}
}
function stopResultCompletionRecheck() {
  clearTimeout(resultCompletionTimer);
  resultCompletionTimer=null;
  resultCompletionTimerKey="";
}
function scheduleResultCompletionRecheck(room) {
  const round=room?.round||{}, started=Number(round.revealCompletedAt), duration=Number(round.roulettePlan?.durationMs);
  const key=resultPresentationKey(room);
  if(!Number.isFinite(started)||started<=0||!Number.isFinite(duration)||duration<0||resultPresentationFinished(room)){
    stopResultCompletionRecheck();
    return;
  }
  const remaining=Math.max(0,started+duration-serverNow());
  stopResultCompletionRecheck();
  resultCompletionTimerKey=key;
  resultCompletionTimer=setTimeout(()=>{
    resultCompletionTimer=null;
    if(resultCompletionTimerKey!==key||latestRoom?.round?.phase!=="result"||resultPresentationKey(latestRoom)!==key)return;
    enterResultScreen(latestRoom);
  },remaining+20);
}
function startResultVisibilitySync() {
  stopResultVisibilitySync();
  resultVisibilityHandler=()=>{
    if(document.visibilityState==="visible"&&latestRoom?.round?.phase==="result") enterResultScreen(latestRoom);
  };
  document.addEventListener("visibilitychange",resultVisibilityHandler);
}
function canProgress(room) { return room?.status === "started" && !roomEnded(room) && !disconnectedPlayers(room).length; }
function currentRoundNumber(room) { return Number(room?.round?.number || 1); }
function shuffledWords(words) {
  const result = [...words];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
function allReplayChoices(room) {
  return Array.isArray(room?.seats) && room.seats.length >= 2
    && room.seats.every(uid => room.replayChoices?.[uid] === true);
}
async function chooseFinalReplay() {
  const room = latestRoom;
  const uid = currentUser?.uid;
  if (!room || !uid || room.round?.phase !== "final" || roomEnded(room) || room.replayChoices?.[uid] === true) return;
  await set(ref(window.__firebaseDatabase, `${roomPath(roomId)}/replayChoices/${uid}`), true);
}
async function restartFinalFeast() {
  const room = latestRoom;
  if (!room || room.round?.phase !== "final" || roomEnded(room) || !canProgress(room) || room.parentUid !== currentUser?.uid || !allReplayChoices(room) || phaseTransitionPending) return;
  phaseTransitionPending = true;
  try {
    const seats = shuffledWords(room.seats);
    const updates = {
      [`${roomPath(roomId)}/seats`]: seats,
      [`${roomPath(roomId)}/parentUid`]: seats[0],
      [`${roomPath(roomId)}/round/number`]: 1,
      [`${roomPath(roomId)}/round/phase`]: "draw",
      [`${roomPath(roomId)}/round/cardId`]: null,
      [`${roomPath(roomId)}/round/cardImage`]: null,
      [`${roomPath(roomId)}/round/publicWords`]: null,
      [`${roomPath(roomId)}/round/publicAnswers`]: null,
      [`${roomPath(roomId)}/round/discussionStartedAt`]: null,
      [`${roomPath(roomId)}/round/discussionDurationSeconds`]: null,
      [`${roomPath(roomId)}/round/answerStartedAt`]: null,
      [`${roomPath(roomId)}/round/revealStartedAt`]: null,
      [`${roomPath(roomId)}/round/revealCompletedAt`]: null,
      [`${roomPath(roomId)}/round/parentCandidateIndex`]: null,
      [`${roomPath(roomId)}/round/roulettePlan`]: null,
      [`${roomPath(roomId)}/replayChoices`]: null,
      [`${historyPath(roomId)}`]: null,
      [`roomSecrets/${roomId}`]: null,
      [`roomProgress/${roomId}`]: null,
      [`roomAnswers/${roomId}`]: null
    };
    playerEntries(room).forEach(player => { updates[`${roomPath(roomId)}/players/${player.uid}/score`] = 0; });
    await update(ref(window.__firebaseDatabase), updates);
  } finally {
    phaseTransitionPending = false;
  }
}
function stopDiscussionTimer() {
  clearInterval(discussionTimer);
  discussionTimer = null;
  discussionTimerRound = "";
}
function createServerTimeOffsetReadyPromise() {
  serverTimeOffsetReadyPromise = new Promise((resolve,reject) => {
    resolveServerTimeOffsetReady = resolve;
    rejectServerTimeOffsetReady = reject;
  });
  serverTimeOffsetReadyPromise.catch(() => {});
}
function stopServerClockRetry() {
  serverTimeOffsetRetryUnsubscribe?.();
  serverTimeOffsetRetryUnsubscribe = null;
}
function retryServerClockOnReconnect(database) {
  if (!database || serverTimeOffsetRetryUnsubscribe) return;
  let sawDisconnected = false;
  serverTimeOffsetRetryUnsubscribe = onValue(ref(database, ".info/connected"), snapshot => {
    const connected = snapshot.val() === true;
    if (!connected) {
      sawDisconnected = true;
      return;
    }
    if (!sawDisconnected || serverTimeOffsetReady || serverTimeOffsetUnsubscribe) return;
    stopServerClockRetry();
    subscribeServerClock(database);
  }, error => {
    console.warn("Firebase再接続状態を受信できませんでした。", error);
  });
}
function subscribeServerClock(database) {
  if (!database || serverTimeOffsetUnsubscribe || serverTimeOffsetReady) return;
  stopServerClockRetry();
  serverTimeOffsetDatabase = database;
  if (!serverTimeOffsetReadyPromise) createServerTimeOffsetReadyPromise();
  const generation = ++serverTimeOffsetGeneration;
  let unsubscribe = null;
  unsubscribe = onValue(
    ref(database, ".info/serverTimeOffset"),
    snapshot => {
      if (generation !== serverTimeOffsetGeneration) return;
      const offset = Number(snapshot.val());
      serverTimeOffset = Number.isFinite(offset) ? offset : 0;
      if (!serverTimeOffsetReady) {
        serverTimeOffsetReady = true;
        resolveServerTimeOffsetReady?.();
        resolveServerTimeOffsetReady = null;
        rejectServerTimeOffsetReady = null;
      }
      if(latestRoom?.round?.phase==="result")enterResultScreen(latestRoom);
    },
    error => {
      if (generation !== serverTimeOffsetGeneration) return;
      serverTimeOffsetGeneration += 1;
      unsubscribe?.();
      if (serverTimeOffsetUnsubscribe === unsubscribe) serverTimeOffsetUnsubscribe = null;
      serverTimeOffsetDatabase = null;
      if (!serverTimeOffsetReady) {
        const reject = rejectServerTimeOffsetReady;
        createServerTimeOffsetReadyPromise();
        reject?.(error);
      }
      retryServerClockOnReconnect(database);
    }
  );
  if (generation === serverTimeOffsetGeneration) serverTimeOffsetUnsubscribe = unsubscribe;
  else unsubscribe?.();
}
function waitForServerTimeOffset(database) {
  subscribeServerClock(database);
  return serverTimeOffsetReady ? Promise.resolve() : serverTimeOffsetReadyPromise;
}
const serverNow = () => Date.now() + serverTimeOffset;
function discussionTimeLabel(seconds) {
  const safeSeconds=Math.max(0,Math.ceil(seconds));
  return `${Math.floor(safeSeconds/60)}:${String(safeSeconds%60).padStart(2,"0")}`;
}
function setSecretSubscription(room) {
  secretUnsubscribe?.(); secretUnsubscribe = null; secretSubscriptionKey=""; parentSecret = null;
  if (room?.parentUid !== currentUser?.uid || !room?.round?.number) return;
  const key=`${roomId}:${currentRoundNumber(room)}:${currentUser.uid}`;
  secretSubscriptionKey=key;
  secretUnsubscribe = onValue(ref(window.__firebaseDatabase, secretPath(roomId, currentRoundNumber(room), currentUser.uid)), snapshot => {
    if(secretSubscriptionKey!==key)return;
    parentSecret = snapshot.val();
    if (latestRoom?.round?.phase === "parent-word") enterParentWordScreen(latestRoom);
  });
}
function setProgressSubscription(room) {
  const roundNumber=currentRoundNumber(room), key=roomId+":"+roundNumber;
  if(progressSubscriptionKey===key)return;
  progressUnsubscribe?.(); progressSubscriptionKey=key; roundProgress={};
  progressUnsubscribe=onValue(ref(window.__firebaseDatabase,progressPath(roomId,roundNumber)),snapshot=>{
    if(progressSubscriptionKey!==key)return;
    roundProgress=snapshot.val()||{};
    if(latestRoom?.round?.phase==="discussion") { enterDiscussionScreen(latestRoom); maybeAdvanceToAnswer(latestRoom); }
    if(latestRoom?.round?.phase==="answer") { enterAnswerScreen(latestRoom); maybeAdvanceToReveal(latestRoom); }
    if(latestRoom?.round?.phase==="reveal") enterRevealScreen(latestRoom);
    if(latestRoom?.round?.phase==="result") enterResultScreen(latestRoom);
  });
}
function setAnswerSubscription(room) {
  const roundNumber=currentRoundNumber(room), key=roomId+":"+roundNumber+":"+(currentUser?.uid||"");
  if(answerSubscriptionKey!==key){
    answerUnsubscribe?.(); answerSubscriptionKey=key; ownAnswer=null; selectedCandidateIndex=null;
    answerUnsubscribe=onValue(ref(window.__firebaseDatabase,answerPath(roomId,roundNumber,currentUser.uid)),snapshot=>{
      if(answerSubscriptionKey!==key)return;
      ownAnswer=snapshot.val();
      if(latestRoom?.round?.phase==="answer") enterAnswerScreen(latestRoom);
    });
  }
  const summaryKey=roomId+":"+roundNumber+":"+(room.parentUid===currentUser?.uid?"parent":"other");
  if(answerSummarySubscriptionKey!==summaryKey){
    answerSummaryUnsubscribe?.(); answerSummarySubscriptionKey=summaryKey;
    if(room.parentUid===currentUser?.uid){
      answerSummaryUnsubscribe=onValue(ref(window.__firebaseDatabase,answerRoundPath(roomId,roundNumber)),snapshot=>{
        if(answerSummarySubscriptionKey!==summaryKey)return;
        if(latestRoom?.round?.phase==="answer") maybeAdvanceToReveal(latestRoom,snapshot.val()||{});
      });
    } else {
      answerSummaryUnsubscribe=null;
    }
  }
}
function enterDrawScreen(room) {
  const isParent=room.parentUid===currentUser?.uid,parentName=playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親",disconnected=disconnectedPlayers(room);
  show("round"); renderPlayerBar(room, "round");const title=roundTitleRow("round")?.querySelector("[data-round-title]");if(title)title.textContent=`${roundLabel(room)}　札選び`;$("#round-title").textContent="";
  $("#round-card-message").textContent="";$("#round-card-message").hidden=true;
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else setRoundMessage(isParent?`${parentName}さん、伏せ札の山から1枚引いてください。`:`${parentName}さんが札を選んでいます。`);
  const enabled=canProgress(room)&&isParent, deck=$("#deck-stack-image"), button=$("#round-start-button");
  button.hidden=!isParent;
  button.disabled=!enabled;
  $("#draw-card").textContent=roomEnded(room)?"宴はお開きです":disconnected.length?"復帰を待っています":"伏せ札を引く";
  button.onclick=isParent?drawMultiplayerCard:null;
  deck.classList.toggle("is-passive",!isParent);
  deck.setAttribute("aria-disabled",String(!enabled));
  deck.tabIndex=isParent?0:-1;
  deck.onclick=isParent?drawMultiplayerCard:null;
  deck.onkeydown=isParent?(event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();drawMultiplayerCard();}}):null;
}
function enterParentWordScreen(room) {
  const isParent=room.parentUid===currentUser?.uid, disconnected=disconnectedPlayers(room), card=room.round;
  show("parent-input"); renderPlayerBar(room, "parent-input");
  const title=roundTitleRow("parent-input")?.querySelector("[data-round-title]"); if(title)title.textContent=`${roundLabel(room)}　親のひそめごと`;
  const parentSubtitle=$('[data-screen="parent-input"] .screen-subtitle'); if(parentSubtitle)parentSubtitle.hidden=true;
  $("#parent-card-area").innerHTML=multiplayerCardMarkup(card?.cardImage);
  $("#parent-secret-description").textContent="4つ目にあなたのワードを入力してください。";
  $("#parent-secret-description").hidden=!isParent;
  $("#official-preview").hidden=!isParent;
  $("#parent-word").hidden=!isParent;
  $("#parent-error").hidden=!isParent;
  $("#parent-submit").hidden=!isParent;
  $("#parent-word").value=parentSecret?.parentWord || "";
  const ready=isParent&&Array.isArray(parentSecret?.officialWords);
  const hasConfirmedWord=Boolean(parentSecret?.parentWord);
  $("#official-preview").innerHTML=ready?parentSecret.officialWords.map(word=>`<div class="word official">${escape(word)}</div>`).join(""):"";
  $("#parent-submit").disabled=!ready||!canProgress(room);
  $("#parent-submit").textContent="ひそめる";
  $("#parent-redraw-button").disabled=!isParent||!canProgress(room);
  $("#parent-redraw-button").hidden=!isParent;
  if(parentWordErrorKey!==parentWordErrorKeyFor(room)){parentWordError="";parentWordErrorKey="";}
  $("#parent-error").textContent=parentWordError;
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else setRoundMessage(isParent?(ready?"公式ワード3つを確認し、親ワードをひそめてください。":"親専用の札情報を読み込んでいます。"):`${playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親"}さんがひそめごとを考えています。`);
  $("#parent-submit").onclick=hasConfirmedWord?publishParentWords:submitParentWord;
  $("#parent-redraw-button").onclick=redrawMultiplayerCard;
}
function enterWordOpenScreen(room) {
  const words=Array.isArray(room.round?.publicWords)?room.round.publicWords:[];
  show("word-open"); renderPlayerBar(room, "word-open");
  const title=roundTitleRow("word-open")?.querySelector("[data-round-title]"); if(title)title.textContent=`${roundLabel(room)}　言葉のお披露目`;
  $("#public-card-area").innerHTML=multiplayerCardMarkup(room.round?.cardImage);
  $("#word-open-words").innerHTML=words.map(word=>`<div class="word">${escape(word)}</div>`).join("");
  $("#word-open-button").hidden=true;
  setRoundMessage("親が4つの言葉をお披露目しました。宴の推理は次の工程で開始します。");
}
function enterDiscussionScreen(room) {
  const round=room.round||{}, words=Array.isArray(round.publicWords)?round.publicWords:[];
  const isChild=room.parentUid!==currentUser?.uid;
  show("discussion"); renderPlayerBar(room, "discussion");
  const title=roundTitleRow("discussion")?.querySelector("[data-round-title]"); if(title)title.textContent=`${roundLabel(room)}　宴の推理`;
  $("#discussion-card-area").innerHTML=multiplayerCardMarkup(round.cardImage);
  $("#public-words").innerHTML=words.map((word,index)=>`<div class="word"><span class="word-number" aria-hidden="true">${index+1}</span><span class="word-text">${escape(word)}</span></div>`).join("");
  const completed=Boolean(roundProgress?.discussion?.[currentUser?.uid]);
  $("#discussion-guide").textContent="心が決まりましたら「推理完了」を押してください。";
  $("#discussion-guide").hidden=!isChild||completed;
  $("#discussion-end").hidden=!isChild||completed;
  $("#discussion-end").disabled=!canProgress(room);
  $("#discussion-end").onclick=completeDiscussion;
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else setRoundMessage(isChild?"会話しながら、親がひそめたワードを推理してください。":"子が親ワードを推理しています。高貴に振る舞いましょう。");
  const startedAt=Number(round.discussionStartedAt), duration=Number(round.discussionDurationSeconds);
  const timerKey=`${round.number}:${startedAt}:${duration}`;
  if(discussionTimerRound===timerKey)return;
  stopDiscussionTimer(); discussionTimerRound=timerKey;
  const tick=()=>{
    const remaining=startedAt&&duration?startedAt+duration*1000-serverNow():0;
    $("#timer").textContent=discussionTimeLabel(remaining/1000);
    if(remaining<=0){
      stopDiscussionTimer();
      if(!roomEnded(latestRoom)&&!disconnectedPlayers(latestRoom).length)maybeAdvanceToAnswer(latestRoom);
    }
  };
  tick();
  if(startedAt&&duration)discussionTimer=setInterval(tick,100);
}
async function completeDiscussion() {
  const room=latestRoom;
  if(!room||room.parentUid===currentUser?.uid||room.round?.phase!=="discussion"||!canProgress(room)||roundProgress?.discussion?.[currentUser.uid])return;
  const button=$("#discussion-end"); button.disabled=true;
  try {
    await set(ref(window.__firebaseDatabase,`${progressPath(roomId,currentRoundNumber(room))}/discussion/${currentUser.uid}`),true);
  } catch(error) { button.disabled=false; setRoundMessage(`推理完了を保存できませんでした。${error.message||""}`); }
}
async function maybeAdvanceToAnswer(room) {
  if(phaseTransitionPending||!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="discussion"||!canProgress(room))return;
  const children=playerEntries(room).filter(player=>player.uid!==room.parentUid);
  const allComplete=children.length>0&&children.every(player=>roundProgress?.discussion?.[player.uid]===true);
  const timedOut=Number(room.round?.discussionStartedAt)&&Number(room.round?.discussionDurationSeconds)&&Number(room.round.discussionStartedAt)+Number(room.round.discussionDurationSeconds)*1000<=serverNow();
  if(!allComplete&&!timedOut)return;
  phaseTransitionPending=true;
  try { await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"answer",answerStartedAt:serverTimestamp()}); }
  catch(error) { setRoundMessage(`推理結果の記帳を開始できませんでした。${error.message||""}`); }
  finally { phaseTransitionPending=false; }
}
function enterAnswerScreen(room) {
  const round=room.round||{},words=Array.isArray(round.publicWords)?round.publicWords:[],isParent=room.parentUid===currentUser?.uid;
  show("answer"); renderPlayerBar(room,"answer"); setAnswerSubscription(room);
  const title=roundTitleRow("answer")?.querySelector("[data-round-title]"); if(title)title.textContent=`${roundLabel(room)}　推理結果の記帳`;
  $("#answer-card-area").innerHTML=multiplayerCardMarkup(round.cardImage);
  $("#answer-title").textContent="";
  const guide=$("#answer-guide-text"), submit=$("#answer-submit");
  guide.textContent="選択が終わりましたら「決定」を押してください。";
  guide.hidden=isParent||Boolean(ownAnswer);
  submit.hidden=isParent||Boolean(ownAnswer);
  submit.disabled=selectedCandidateIndex===null||!canProgress(room);
  $("#answer-words").innerHTML=words.map((word,index)=>{
    if(isParent)return `<div class="word"><span class="word-number" aria-hidden="true">${index+1}</span><span class="word-text">${escape(word)}</span></div>`;
    const chosen=ownAnswer?Number(ownAnswer.candidateIndex)===index:selectedCandidateIndex===index;
    const interactive=!ownAnswer;
    return `<button class="word word-button${chosen?" is-selected":""}" type="button" data-answer-index="${index}" ${interactive?"":"disabled"}><span class="word-number" aria-hidden="true">${index+1}</span><span class="word-text">${escape(word)}</span></button>`;
  }).join("");
  if(!isParent)$("#answer-words").querySelectorAll("[data-answer-index]").forEach(button=>button.onclick=()=>{selectedCandidateIndex=Number(button.dataset.answerIndex);enterAnswerScreen(latestRoom);});
  submit.onclick=submitAnswer;
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else setRoundMessage(isParent?"子が推理結果を記帳しています。":"親ワードだと思う言葉を1つ選んでください。");
}
async function maybeAdvanceToReveal(room, answersSnapshot=null) {
  if(phaseTransitionPending||!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="answer"||!canProgress(room))return;
  const children=playerEntries(room).filter(player=>player.uid!==room.parentUid);
  const progress=roundProgress?.answers||{};
  if(!children.length||!children.every(player=>progress[player.uid]===true))return;
  phaseTransitionPending=true;
  try {
    const answers=answersSnapshot||((await get(ref(window.__firebaseDatabase,answerRoundPath(roomId,currentRoundNumber(room))))).val()||{});
    const publicAnswers={};
    for(const child of children){
      const candidateIndex=Number(answers?.[child.uid]?.candidateIndex);
      if(!Number.isInteger(candidateIndex)||candidateIndex<0||candidateIndex>3)return;
      const candidateKey=String(candidateIndex);
      if(!publicAnswers[candidateKey])publicAnswers[candidateKey]={};
      publicAnswers[candidateKey][child.uid]=true;
    }
    await update(ref(window.__firebaseDatabase,roomPath(roomId)+"/round"),{
      phase:"reveal",
      publicAnswers,
      revealStartedAt:serverTimestamp()
    });
  } catch(error) {
    setRoundMessage("ひそめごと開帳の準備に失敗しました。"+(error.message||""));
  } finally {
    phaseTransitionPending=false;
  }
}
function enterRevealScreen(room) {
  const round=room.round||{}, isParent=room.parentUid===currentUser?.uid;
  const parentName=playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親";
  const revealScreen=document.querySelector('[data-screen="result-open"]');
  revealScreen?.classList.add("is-multiplayer-reveal");
  show("result-open"); renderPlayerBar(room,"result-open");
  const title=roundTitleRow("result-open")?.querySelector("[data-round-title]");
  if(title)title.textContent=roundLabel(room)+"　ひそめごと開帳";
  $("#result-open-card-area").innerHTML=multiplayerCardMarkup(round.cardImage);
  $("#result-open-description").hidden=true;
  const publicAnswers=round.publicAnswers||{};
  const words=Array.isArray(round.publicWords)?round.publicWords:[];
  $("#selection-summary").innerHTML=words.map((word,index)=>{
    const voters=Object.keys(publicAnswers[String(index)]||{}).map(uid=>playerEntries(room).find(player=>player.uid===uid)?.name||"不明");
    return '<div class="vote-card"><div class="word">'+escape(word)+'</div><div class="vote-count">'+voters.length+'票</div><div class="voters">'+(voters.length?voters.map(escape).join("、"):"選択者なし")+'</div></div>';
  }).join("");
  const button=$("#result-open-button");
  button.hidden=!isParent;
  button.disabled=!isParent||!canProgress(room)||Boolean(round.revealCompletedAt);
  window.__restoreMultiplayerRevealButton?.();
  button.removeEventListener("click",window.__singleResultOpenHandler);
  button.removeEventListener("click",completeReveal);
  if(isParent)button.addEventListener("click",completeReveal);
  if(roomEnded(room))setRoundMessage(room.endedBy.name+"が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。");
  else setRoundMessage("全員の記帳が完了しました。"+parentName+"さん、ひそめごとを開帳してください。");
}
function multiplayerVoteData(room) {
  const round=room.round||{}, words=Array.isArray(round.publicWords)?round.publicWords:[], publicAnswers=round.publicAnswers||{};
  return words.map((word,index)=>{
    const voters=Object.keys(publicAnswers[String(index)]||{}).map(uid=>playerEntries(room).find(player=>player.uid===uid)).filter(Boolean);
    return {word,index,voters};
  });
}
function multiplayerResultSummary(room) {
  const votes=multiplayerVoteData(room), children=playerEntries(room).filter(player=>player.uid!==room.parentUid);
  const parentIndex=Number(room.round?.parentCandidateIndex), correct=votes[parentIndex]?.voters||[];
  if(correct.length===0)return children.length===1?"<strong>子が不正解</strong><span>得点なし</span>":"<strong>全員不正解</strong><span>親：+1ポイント</span>";
  if(correct.length===children.length)return children.length===1?"<strong>子が正解</strong><span>子：+1ポイント</span>":"<strong>全員正解</strong><span>子：全員+1ポイント<br>親：−1ポイント</span>";
  return "<strong>一部の子が正解</strong><span>正解した子：各+1ポイント</span>";
}
function multiplayerRoundForScoring(room) {
  const players=room.seats.map(uid=>({id:uid,name:room.players?.[uid]?.name||"不明",score:Number(room.players?.[uid]?.score)||0}));
  const answers={};
  Object.entries(room.round?.publicAnswers||{}).forEach(([candidateIndex,voters])=>{
    Object.keys(voters||{}).forEach(uid=>{answers[uid]=Number(candidateIndex);});
  });
  return {players,order:players.map((_,index)=>index),parentIndex:room.seats.indexOf(room.parentUid),answers,parentCandidateId:Number(room.round?.parentCandidateIndex)};
}
function multiplayerScoreOutcome(room) { return scoreRound(multiplayerRoundForScoring(room)); }
function multiplayerScoreTitle(room) {
  const {children,correct}=multiplayerScoreOutcome(room);
  return children.length===1?(correct.length===0?"子が不正解":"子が正解"):(correct.length===0?"全員不正解":correct.length===children.length?"全員正解":"一部の子が正解");
}
function multiplayerHistorySummary(room) {
  const {children,correct}=multiplayerScoreOutcome(room);
  if(children.length===1)return correct.length===0?"子が不正解。得点なし":"子が正解。子プラス1ポイント";
  if(correct.length===0)return "全員不正解。親プラス1ポイント";
  if(correct.length===children.length)return "全員正解。子プラス1ポイント、親マイナス1ポイント";
  return "一部の子が正解。正解した子に1ポイント";
}
function multiplayerHistoryRecord(room) {
  const round=room.round||{}, number=currentRoundNumber(room), words=Array.isArray(round.publicWords)?round.publicWords:[];
  if(words.length!==4||!words.every(word=>typeof word==="string"))throw Error("戦績に必要な公開語を確認できません。");
  const answers={};
  playerEntries(room).filter(player=>player.uid!==room.parentUid).forEach(player=>{
    const candidateIndex=Object.keys(round.publicAnswers||{}).find(index=>round.publicAnswers?.[index]?.[player.uid]===true);
    if(candidateIndex===undefined)throw Error("戦績に必要な回答を確認できません。");
    answers[player.uid]={name:player.name,candidateIndex:Number(candidateIndex)};
  });
  const parentCandidateIndex=Number(round.parentCandidateIndex);
  if(!Number.isInteger(parentCandidateIndex)||parentCandidateIndex<0||parentCandidateIndex>3)throw Error("親ワードの位置を確認できません。");
  return {round:number,parentUid:room.parentUid,parentName:room.players?.[room.parentUid]?.name||"親",cardId:round.cardId,cardImage:round.cardImage,image:round.cardImage,words,parentCandidateIndex,parentWord:words[parentCandidateIndex],answers,summary:multiplayerHistorySummary(room)};
}
function renderMultiplayerHistory() {
  if(!latestRoom||!roomId)return false;
  const scores=$("#history-scores"), list=$("#history-list"), records=Object.values(multiplayerHistory||{}).sort((a,b)=>Number(b.round)-Number(a.round));
  if(scores)scores.innerHTML=`<p class="history-label">現在のポイント</p><div class="history-score-list">${playerEntries(latestRoom).map(player=>`<div class="history-score"><span>${escape(player.name)}</span><strong>${Number(player.score)||0}ポイント</strong></div>`).join("")}</div>`;
  if(list)list.innerHTML=records.length?records.map(record=>{const label=roundLabelForNumber(record.round);return `<article class="history-entry"><div class="history-entry-heading"><h3>${label}</h3></div><div class="history-entry-overview">${record.cardImage?`<div class="history-card-area"><img class="card-zoom-trigger" src="${escape(record.cardImage)}" alt="${label}のお題カード。タップで拡大表示" tabindex="0" role="button"></div>`:""}<div class="history-result"><p class="result-parent">親：${escape(record.parentName)}</p><p class="history-summary">${escape(record.summary)}</p></div></div><div class="history-vote-list">${(Array.isArray(record.words)?record.words:[]).map((word,index)=>{const voters=Object.values(record.answers||{}).filter(answer=>Number(answer.candidateIndex)===index).map(answer=>escape(answer.name));return `<div class="vote-card${word===record.parentWord?" parent-answer":""}" data-parent-word="${word===record.parentWord}"><div class="word">${escape(word)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.join("、"):"選択者なし"}</div></div>`;}).join("")}</div></article>`;}).join(""):'<p class="history-empty">まだ結果が確定したラウンドはありません。</p>';
  return true;
}
function hasWinner(room) { return playerEntries(room).some(player=>(Number(player.score)||0)>=5); }
function renderMultiplayerResultVotes(room) {
  const parentIndex=Number(room.round?.parentCandidateIndex), finished=resultPresentationFinished(room);
  $("#result-votes").innerHTML=multiplayerVoteData(room).map(({word,index,voters})=>{
    return '<div class="vote-card'+(finished&&index===parentIndex?" parent-answer":"")+'" data-parent-word="'+(index===parentIndex?"true":"false")+'"><div class="word">'+escape(word)+'</div><div class="vote-count">'+voters.length+'票</div><div class="voters">'+(voters.length?voters.map(player=>escape(player.name)).join("、"):"選択者なし")+'</div></div>';
  }).join("");
}
function enterScoreScreen(room) {
  stopResultVisibilitySync();
  stopResultCompletionRecheck();
  window.__rouletteController?.cancel?.();
  resultRouletteKey="";
  const isParent=room.parentUid===currentUser?.uid, parentName=playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親";
  show("scores"); renderPlayerBar(room,"scores");
  const title=roundTitleRow("scores")?.querySelector("[data-round-title]");
  if(title)title.textContent=roundLabel(room)+"　得点の記録";
  $("#score-title").textContent=multiplayerScoreTitle(room);
  $("#score-summary").innerHTML=room.seats.map(uid=>{const player=room.players?.[uid]||{};return `<div class="player-item"><span>${escape(player.name||"不明")}</span><span>${Number(player.score)||0}ポイント</span></div>`;}).join("");
  const next=$("#next-round");
  next.textContent="次の席へ"; next.hidden=!isParent; next.onclick=null;
  next.removeEventListener("click",window.__singleNextRoundHandler);
  next.removeEventListener("click",advanceToNextSeat);
  if(isParent)next.addEventListener("click",advanceToNextSeat);
  next.disabled=!isParent||!canProgress(room)||hasWinner(room)||phaseTransitionPending;
  if(roomEnded(room))setRoundMessage(room.endedBy.name+"が退出したため、宴はお開きとなりました。右上メニューの「退出」から退出してください。");
  else setRoundMessage(`得点が反映されました。${parentName}さん、次の席へ進んでください。`);
}
function enterMultiplayerFinalScreen(room) {
  stopResultVisibilitySync();
  stopResultCompletionRecheck();
  const players = playerEntries(room).map(player => ({ id: player.uid, name: player.name, score: Number(player.score) || 0 }));
  const winners = players.filter(player => player.score >= 5);
  const cards = Object.values(multiplayerHistory || {})
    .sort((a, b) => Number(a.round) - Number(b.round))
    .map(record => ({ round: record.round, image: record.cardImage || record.image }));
  const choiceMade = room.replayChoices?.[currentUser?.uid] === true;
  const ended = roomEnded(room);
  const finalKey = `${roomId}:${room.round?.number}:${room.round?.cardId}`;
  const finalRoundHistoryReady = Object.prototype.hasOwnProperty.call(multiplayerHistory, String(currentRoundNumber(room)));
  const firstFinalEntry = multiplayerFinalKey !== finalKey;
  const cardsKey = cards.map(card => `${card.round}:${card.image || ""}`).join("|");
  const presentationKey = players.map(player => `${player.id}:${player.name}:${player.score}`).join("|");
  const cardsChanged = firstFinalEntry || multiplayerFinalCardsKey !== cardsKey;
  const presentationChanged = firstFinalEntry || multiplayerFinalPresentationKey !== presentationKey;
  if (finalRoundHistoryReady) multiplayerFinalKey = finalKey;
  multiplayerFinalCardsKey = cardsKey;
  multiplayerFinalPresentationKey = presentationKey;
  renderPlayerBar(room, "final");
  const title = roundTitleRow("final")?.querySelector("[data-round-title]");
  if (title) title.textContent = "宴の結び";
  window.showMultiplayerFinalResults?.(players, winners, cards, { animate: firstFinalEntry && finalRoundHistoryReady, cardsChanged, presentationChanged });
  const toTitle = $("#final-to-title");
  const replay = $("#final-replay");
  toTitle.disabled = ended || choiceMade || phaseTransitionPending;
  replay.disabled = ended || choiceMade || phaseTransitionPending;
  toTitle.onclick = async event => {
    event.preventDefault();
    if (toTitle.disabled) return;
    try { await exitStartedFeast(); }
    catch (error) { setRoundMessage(`退出できませんでした。${error.message || ""}`); }
  };
  replay.onclick = async event => {
    event.preventDefault();
    if (replay.disabled) return;
    replay.disabled = true;
    toTitle.disabled = true;
    try { await chooseFinalReplay(); }
    catch (error) {
      replay.disabled = false;
      toTitle.disabled = false;
      setRoundMessage(`再宴希望を保存できませんでした。${error.message || ""}`);
    }
  };
  if (!ended && canProgress(room) && allReplayChoices(room) && room.parentUid === currentUser?.uid) {
    restartFinalFeast().catch(error => setRoundMessage(`再宴を開始できませんでした。${error.message || ""}`));
  }
  if (ended) setRoundMessage(`${room.endedBy?.name || "参加者"}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else setRoundMessage("宴の結果をご確認ください。");
}
function enterResultScreen(room) {
  stopResultVisibilitySync();
  startResultVisibilitySync();
  const round=room.round||{}, isParent=room.parentUid===currentUser?.uid;
  const key=resultPresentationKey(room);
  resumeDebug("result:enter",{key,clockReady:serverTimeOffsetReady,hasPlan:Boolean(round.roulettePlan),hasStartedAt:Number.isFinite(Number(round.revealCompletedAt)),controller:Boolean(window.__rouletteController)});
  const renderBase=()=>{
    document.querySelector('[data-screen="result-open"]')?.classList.remove("is-multiplayer-reveal");
    show("result");
    renderPlayerBar(room,"result");
    const title=roundTitleRow("result")?.querySelector("[data-round-title]");
    if(title)title.textContent=roundLabel(room)+"　宴の顛末";
  };
  if (!serverTimeOffsetReady) {
    resumeDebug("result:wait-server-clock",{key});
    renderBase();
    $("#result-card-area").innerHTML=multiplayerCardMarkup(round.cardImage);
    renderMultiplayerResultVotes(room);
    $("#result-parent").textContent="";
    $("#result-reveal-status").textContent="共有時刻を確認しています。";
    $("#result-summary").innerHTML="";
    const next=$("#result-next");
    next.hidden=!isParent;
    next.disabled=true;
    if (resultClockWaitKey !== key) {
      resultClockWaitKey = key;
      const waitGeneration = ++resultClockWaitGeneration;
      waitForServerTimeOffset(window.__firebaseDatabase).then(() => {
        resumeDebug("result:server-clock-ready",{key});
        if (waitGeneration === resultClockWaitGeneration && latestRoom?.round?.phase === "result") enterResultScreen(latestRoom);
      }).catch(error => {
        resumeDebug("result:server-clock-error",{key,message:error.message||String(error)});
        if (waitGeneration === resultClockWaitGeneration && latestRoom?.round?.phase === "result" && resultClockWaitKey === key) {
          resultClockWaitKey = "";
          $("#result-reveal-status").textContent="共有時刻を確認できません。"+(error.message || "");
        }
      });
    }
    return;
  }
  resultClockWaitKey = "";
  const finished=resultPresentationFinished(room), elapsed=resultElapsedMs(room);
  resumeDebug("result:restore",{key,finished,elapsed,planDuration:Number(round.roulettePlan?.durationMs)||null});
  scheduleResultCompletionRecheck(room);
  if (!finished && resultRouletteKey === key) {
    renderBase();
    const next=$("#result-next");
    next.hidden=!isParent;
    next.disabled=true;
    if(roomEnded(room))setRoundMessage(room.endedBy.name+"が退出したため、宴はお開きとなりました。右上メニューの「退出」から退出してください。");
    else setRoundMessage("ひそめごとを開帳しています。");
    return;
  }
  renderBase();
  $("#result-card-area").innerHTML=multiplayerCardMarkup(round.cardImage);
  renderMultiplayerResultVotes(room);
  $("#result-parent").textContent="";
  $("#result-reveal-status").textContent="";
  $("#result-summary").innerHTML="";
  const summary=multiplayerResultSummary(room);
  const next=$("#result-next");
  next.hidden=!isParent;
  next.disabled=!isParent||!finished||!canProgress(room);
  window.__restoreMultiplayerResultButton?.();
  if(isParent){
    next.onclick=null;
    next.removeEventListener("click",completeScore);
    next.removeEventListener("click",window.__singleResultNextHandler);
    next.removeEventListener("click",window.__singleResultHistoryHandler);
    next.addEventListener("click",completeScore);
  }
  if(roomEnded(room))setRoundMessage(room.endedBy.name+"が退出したため、宴はお開きとなりました。右上メニューの「退出」から退出してください。");
  else setRoundMessage(finished?((playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親")+"さん、得点を確認してください。"):"ひそめごとを開帳しています。");
  const cards=[...document.querySelectorAll("#result-votes .vote-card")], controller=window.__rouletteController;
  if(finished){
    stopResultCompletionRecheck();
    cards.forEach(card=>card.classList.remove("reveal-checking","reveal-flash"));
    cards[Number(round.parentCandidateIndex)]?.classList.add("reveal-parent");
    $("#result-summary").innerHTML=summary;
    return;
  }
  if(controller&&round.roulettePlan&&Number(round.revealCompletedAt)){
    resumeDebug("result:play-plan",{key,elapsed});
    resultRouletteKey=key;
    controller.playPlan({cards,parentIndex:Number(round.parentCandidateIndex),plan:round.roulettePlan,status:$("#result-reveal-status"),summaryEl:$("#result-summary"),next,summary,elapsedMs:elapsed,canEnable:()=>false,onComplete:()=>{if(latestRoom?.round?.phase==="result"&&resultPresentationKey(latestRoom)===key)enterResultScreen(latestRoom);}});
  }
}
window.__restoreMultiplayerRevealButton=()=>{
  const button=$("#result-open-button");
  if(!button)return;
  button.removeEventListener("click",completeReveal);
  button.removeEventListener("click",window.__singleResultOpenHandler);
  if(window.__singleResultOpenHandler)button.addEventListener("click",window.__singleResultOpenHandler);
};
window.__restoreMultiplayerResultButton=()=>{
  const button=$("#result-next");
  if(!button)return;
  button.removeEventListener("click",completeScore);
  button.removeEventListener("click",window.__singleResultNextHandler);
  button.removeEventListener("click",window.__singleResultHistoryHandler);
  button.onclick=window.__singleResultNextHandler||null;
  if(window.__singleResultHistoryHandler)button.addEventListener("click",window.__singleResultHistoryHandler);
};
window.__restoreMultiplayerNextRoundButton=()=>{
  const button=$("#next-round");
  if(!button)return;
  button.removeEventListener("click",advanceToNextSeat);
  button.onclick=window.__singleNextRoundHandler||null;
};
function reevaluateAutomaticTransition(room){
  if(!room||roomEnded(room)||disconnectedPlayers(room).length)return;
  if(room.round?.phase==="discussion")void maybeAdvanceToAnswer(room);
  else if(room.round?.phase==="answer")void maybeAdvanceToReveal(room);
}
async function completeReveal() {
  const room=latestRoom;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="reveal"||!canProgress(room)||room.round?.revealCompletedAt)return;
  const parentCandidateIndex=Number(parentSecret?.parentCandidateIndex);
  const controller=window.__rouletteController;
  if(!Number.isInteger(parentCandidateIndex)||parentCandidateIndex<0||parentCandidateIndex>3||!controller)return;
  const plan=controller.createPlan({count:4,parentIndex:parentCandidateIndex});
  const button=$("#result-open-button"); button.disabled=true;
  try {
    await update(ref(window.__firebaseDatabase,roomPath(roomId)+"/round"),{
      phase:"result",
      parentCandidateIndex,
      roulettePlan:plan,
      revealCompletedAt:serverTimestamp()
    });
  } catch(error) {
    button.disabled=false;
    setRoundMessage("ひそめごと開帳を完了できませんでした。"+(error.message||""));
  }
}
async function completeScore() {
  const room=latestRoom;
  const button=$("#result-next");
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="result"||!resultPresentationFinished(room)||!canProgress(room)||phaseTransitionPending)return;
  phaseTransitionPending=true;
  button.disabled=true;
  let failureMessage="";
  try {
    const current=await getCurrentRoomWithPresence();
    if(!current||current.parentUid!==currentUser?.uid||current.round?.phase!=="result"||!resultPresentationFinished(current)||!canProgress(current))throw Error("得点を反映できる状態ではありません。");
    const scored=multiplayerScoreOutcome(current), roundNumber=currentRoundNumber(current), history=multiplayerHistoryRecord(current), hasWinner=scored.players.some(player=>player.score>=5), updates={[`${roomPath(roomId)}/round/phase`]:hasWinner?"final":"score",[`${historyPath(roomId)}/${roundNumber}`]:history};
    if(multiplayerHistory?.[String(roundNumber)])throw Error("この席の戦績はすでに確定しています。");
    scored.players.forEach(player=>{updates[`${roomPath(roomId)}/players/${player.id}/score`]=player.score;});
    await update(ref(window.__firebaseDatabase),updates);
  } catch(error) {
    button.disabled=false;
    failureMessage="得点確認を保存できませんでした。"+(error.message||"");
    setRoundMessage(failureMessage);
  } finally {
    phaseTransitionPending=false;
    if(latestRoom?.round?.phase==="final")enterMultiplayerFinalScreen(latestRoom);
    else if(latestRoom?.round?.phase==="score")enterScoreScreen(latestRoom);
    else if(latestRoom?.round?.phase==="result")enterResultScreen(latestRoom);
    if(failureMessage&&latestRoom?.round?.phase==="result")setRoundMessage(failureMessage);
  }
}
function resetRoundLocalState() {
  parentSecret=null; parentWordError=""; parentWordErrorKey=""; roundProgress={}; ownAnswer=null; selectedCandidateIndex=null;
  secretUnsubscribe?.(); secretUnsubscribe=null; secretSubscriptionKey="";
  progressUnsubscribe?.(); progressUnsubscribe=null; progressSubscriptionKey="";
  answerUnsubscribe?.(); answerUnsubscribe=null; answerSubscriptionKey="";
  answerSummaryUnsubscribe?.(); answerSummaryUnsubscribe=null; answerSummarySubscriptionKey="";
  stopDiscussionTimer();
  resultRouletteKey=""; resultClockWaitKey=""; resultClockWaitGeneration+=1; resultPresentationCompletedKey=""; stopServerClockRetry(); stopResultCompletionRecheck(); window.__rouletteController?.cancel?.(); stopResultVisibilitySync();
}
async function advanceToNextSeat() {
  const room=latestRoom, button=$("#next-round");
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="score"||!canProgress(room)||hasWinner(room)||phaseTransitionPending)return;
  phaseTransitionPending=true; button.disabled=true;
  try {
    const current=await getCurrentRoomWithPresence();
    if(!current||current.parentUid!==currentUser?.uid||current.round?.phase!=="score"||!canProgress(current)||hasWinner(current))throw Error("次の席へ進める状態ではありません。");
    const index=current.seats.indexOf(current.parentUid);
    if(index<0)throw Error("現在の親を席次から確認できません。");
    const nextRound={number:currentRoundNumber(current)+1,phase:"draw"};
    if(current.round?.usedCardIds)nextRound.usedCardIds=current.round.usedCardIds;
    await update(ref(window.__firebaseDatabase),{
      [`${roomPath(roomId)}/parentUid`]:current.seats[(index+1)%current.seats.length],
      [`${roomPath(roomId)}/round`]:nextRound
    });
    resetRoundLocalState();
  } catch(error) {
    setRoundMessage("次の席へ進めませんでした。"+(error.message||""));
  } finally { phaseTransitionPending=false; }
}
async function submitAnswer() {
  const room=latestRoom;
  if(!room||room.parentUid===currentUser?.uid||room.round?.phase!=="answer"||!canProgress(room)||selectedCandidateIndex===null||ownAnswer)return;
  const submit=$("#answer-submit"); submit.disabled=true;
  try {
    const answer={candidateIndex:selectedCandidateIndex,createdAt:Date.now()};
    await update(ref(window.__firebaseDatabase),{
      [answerPath(roomId,currentRoundNumber(room),currentUser.uid)]:answer,
      [progressPath(roomId,currentRoundNumber(room))+"/answers/"+currentUser.uid]:true
    });
  } catch(error) { submit.disabled=false; setRoundMessage("推理結果を保存できませんでした。"+(error.message||"")); }
}
async function drawMultiplayerCard() {
  const room=latestRoom;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="draw"||!canProgress(room))return;
  const button=$("#round-start-button"); button.disabled=true; $("#draw-card").textContent="お題を準備しています…";
  try {
    await ensureCatalog();
    const cardSet=catalog.find(set=>set.id===room.cardSet), wordSet=cardSet?.wordSets?.find(set=>set.id===room.wordSet);
    const available=(cardSet?.cards||[]).filter(card=>!room.round?.usedCardIds?.[String(card.id)]);
    if(!available.length)throw Error("引ける札がありません。");
    const card=available[crypto.getRandomValues(new Uint32Array(1))[0]%available.length];
    const official=[...(wordSet?.cards?.find(item=>String(item.cardId)===String(card.id))?.officialWords||[])].sort(()=>crypto.getRandomValues(new Uint32Array(1))[0]/0x100000000-.5).slice(0,3);
    if(official.length!==3)throw Error("公式ワードを3個選べませんでした。");
    const roundNumber=currentRoundNumber(room), secret={officialWords:official,cardId:card.id,createdAt:Date.now()};
    try {
      await set(ref(window.__firebaseDatabase,secretPath(roomId,roundNumber,currentUser.uid)),secret);
    } catch (error) {
      throw Error(`親専用の札情報を保存できませんでした。${error.message||""}`);
    }
    try {
      await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"parent-word",cardId:card.id,cardImage:`cards/${room.cardSet}/${card.image}`,[`usedCardIds/${card.id}`]:true});
    } catch (error) {
      throw Error(`札の公開状態を保存できませんでした。${error.message||""}`);
    }
  } catch(error) { $("#round-card-message").hidden=false; $("#round-card-message").textContent=`札を引けませんでした。${error.message||""}`; button.disabled=false; $("#draw-card").textContent="伏せ札を引く"; }
}
async function redrawMultiplayerCard() {
  const room=latestRoom;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  clearParentWordError();
  try { await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"draw",cardId:null,cardImage:null}); }
  catch(error) { setParentWordError(room,`札を引き直せませんでした。${error.message||""}`); }
}
async function submitParentWord() {
  const room=latestRoom, value=$("#parent-word").value.trim();
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  if(!value){setParentWordError(room,"親ワードを入力してください。");return;}
  if(parentSecret?.officialWords?.includes(value)){setParentWordError(room,"公式ワードとは別の言葉を入力してください。");return;}
  clearParentWordError();
  try {
    await update(ref(window.__firebaseDatabase,secretPath(roomId,currentRoundNumber(room),currentUser.uid)),{parentWord:value,parentWordConfirmedAt:Date.now()});
    parentSecret={...(parentSecret||{}),parentWord:value};
    await publishParentWords();
  }
  catch(error) { setParentWordError(room,`親ワードをひそめられませんでした。${error.message||""}`); }
}
async function publishParentWords() {
  const room=latestRoom, secret=parentSecret;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  if(!Array.isArray(secret?.officialWords)||!secret?.parentWord){setParentWordError(room,"親ワードを確認できません。");return;}
  clearParentWordError();
  try {
    const publicWords=Array.isArray(secret.publicWords)?secret.publicWords:shuffledWords([...secret.officialWords,secret.parentWord]);
    const parentCandidateIndex=Number.isInteger(secret.parentCandidateIndex)?secret.parentCandidateIndex:publicWords.indexOf(secret.parentWord);
    const discussionDurationSeconds=Number(room.discussionMinutes)*60;
    if(parentCandidateIndex<0)throw Error("親ワードの候補位置を作成できませんでした。");
    if(!Number.isInteger(discussionDurationSeconds)||discussionDurationSeconds<=0)throw Error("推理時間を確認できませんでした。");
    if(!Array.isArray(secret.publicWords)||!Number.isInteger(secret.parentCandidateIndex)){
      try { await update(ref(window.__firebaseDatabase,secretPath(roomId,currentRoundNumber(room),currentUser.uid)),{publicWords,parentCandidateIndex}); }
      catch(error) { throw Error(`公開語を秘密情報へ保存できませんでした。${error.message||""}`); }
      parentSecret={...secret,publicWords,parentCandidateIndex};
    }
    try { await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"discussion",publicWords,discussionStartedAt:serverTimestamp(),discussionDurationSeconds}); }
    catch(error) { throw Error(`宴の推理開始を保存できませんでした。${error.message||""}`); }
  } catch(error) { setParentWordError(room,`言葉をお披露目できませんでした。${error.message||""}`); }
}
function subscribeHistory(room) {
  if (room?.status !== "started" || !room.players?.[currentUser?.uid]) return;
  const key = `${roomId}:${currentUser.uid}`;
  if (historySubscriptionKey === key) return;
  historyUnsubscribe?.();
  historySubscriptionKey = key;
  multiplayerHistory = {};
  historyUnsubscribe = onValue(
    ref(window.__firebaseDatabase, historyPath(roomId)),
    snapshot => {
      if(historySubscriptionKey!==key)return;
      multiplayerHistory = snapshot.val() || {};
      if (latestRoom?.round?.phase === "final") enterMultiplayerFinalScreen(latestRoom);
    },
    error => {
      historyUnsubscribe?.();
      historyUnsubscribe = null;
      historySubscriptionKey = "";
      console.warn("戦績を受信できませんでした。", error);
    }
  );
}
function subscribeRoom(id) {
  subscribeServerClock(window.__firebaseDatabase);
  roomPresenceUnsubscribe?.();
  roomPresenceUnsubscribe = onValue(ref(window.__firebaseDatabase, roomPresencePath(id)), snapshot => {
    if (roomId !== id) return;
    applyRoomPresence(snapshot.val());
  }, error => {
    resumeDebug("presence:read-error", { code: error?.code || null, message: error?.message || String(error) });
  });
  roomUnsubscribe?.();
  roomUnsubscribe = onValue(
    ref((window.__firebaseDatabase), roomPath(id)),
    snapshot => {
      if(roomId!==id)return;
      return renderWaiting(withRoomPresence(snapshot.val())).catch(error => {
      show("multiplayer-waiting");
      $("#room-waiting-message").textContent = `宴の状態を表示できませんでした。${error.message || ""}`;
      });
    },
    error => {
      show("multiplayer-waiting");
      $("#room-waiting-message").textContent = `宴の状態を受信できませんでした。${error.message || ""}`;
    }
  );
}

function clearInviteUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has("room")) return;
  url.searchParams.delete("room");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearRoomSession() {
  clearStoredResumeAvailability();
  stopStoredSessionReconnectRetry();
  roomUnsubscribe?.();
  roomUnsubscribe = null;
  roomPresenceUnsubscribe?.();
  roomPresenceUnsubscribe = null;
  roomPresence = {};
  historyUnsubscribe?.();
  historyUnsubscribe = null;
  historySubscriptionKey = "";
  multiplayerHistory = {};
  secretUnsubscribe?.();
  secretUnsubscribe = null;
  secretSubscriptionKey = "";
  answerUnsubscribe?.();
  answerUnsubscribe = null;
  answerSummaryUnsubscribe?.();
  answerSummaryUnsubscribe = null;
  answerSubscriptionKey = "";
  answerSummarySubscriptionKey = "";
  progressUnsubscribe?.();
  progressUnsubscribe = null;
  progressSubscriptionKey = "";
  roundProgress = {};
  stopDiscussionTimer();
  ownAnswer = null;
  selectedCandidateIndex = null;
  parentSecret = null;
  document.querySelector('[data-screen="result-open"]')?.classList.remove("is-multiplayer-reveal");
  window.__restoreMultiplayerRevealButton?.();
  window.__restoreMultiplayerResultButton?.();
  window.__restoreMultiplayerNextRoundButton?.();
  resultRouletteKey = "";
  resultClockWaitKey = "";
  resultClockWaitGeneration += 1;
  resultPresentationCompletedKey = "";
  stopServerClockRetry();
  stopResultCompletionRecheck();
  observedRoundKey = "";
  window.__rouletteController?.cancel?.();
  stopResultVisibilitySync();
  stopPresence();
  latestRoom = null;
  roomId = "";
  openedRoom = false;
  forgetRoomSession();
  hideRoundHeader();
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function removeCurrentPlayer(id, uid, nameKey) {
  const snapshot = await get(ref(window.__firebaseDatabase, roomPath(id)));
  const room = snapshot.val();
  const slot = joinSlotForUid(room, uid);
  if (slot) {
    await remove(ref(window.__firebaseDatabase, roomPath(id)+"/joinSlots/"+slot.slot));
    return;
  }
  await update(ref(window.__firebaseDatabase, roomPath(id)), {
    ["players/"+uid]: null,
    ["nameIndex/"+nameKey]: null
  });
}

async function isCurrentPlayerRemoved(id, uid, nameKey) {
  const snapshot = await get(ref(window.__firebaseDatabase, roomPath(id)));
  const room = snapshot.val();
  return !room?.players?.[uid] && !room?.nameIndex?.[nameKey] && !joinSlotForUid(room, uid);
}

async function createRoom() {
  const error = $("#create-room-error");
  error.textContent = "";
  const name = $("#multiplayer-name").value.trim();
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
    hostUid: context.user.uid, feastId: crypto.randomUUID(), status: "waiting", createdAt: Date.now(),
    cardSet: cardSet.id, cardSetName: cardSet.name, wordSet: wordSet.id, wordSetName: wordSet.name,
    discussionMinutes: Number($("#host-discussion-time").value),
    players: { [context.user.uid]: { name, nameKey: key, joinedAt: Date.now() } },
    nameIndex: { [key]: context.user.uid }
  };
  try { await update(ref(context.database, roomPath(roomId)), room); saveName(name); saveRoomSession(room); allowAutoResume(); await startPresence(); subscribeRoom(roomId); show("multiplayer-waiting"); }
  catch (cause) { error.textContent = `部屋を作成できませんでした。${cause.message || ""}`; }
}

async function joinRoom() {
  const error = $("#join-room-error"); error.textContent = "";
  const id = $("#join-room-id").value.trim().toUpperCase();
  const name = $("#multiplayer-name").value.trim();
  if (!id || !name) { error.textContent = "部屋番号と客人名を入力してください。"; return; }
  let joined=false;
  let key="";
  try {
    const context = await getFirebaseContext();
    currentUser = context.user; window.__firebaseDatabase = context.database; openedRoom = false;
    await waitForDatabaseConnection(context.database);
    key = normalizedName(name);
    const joinedAt = Date.now();
    let joinIssue = "";
    for (let slot = 0; slot < 5; slot++) {
      const transaction = await runTransaction(ref(context.database, roomPath(id)+"/joinSlots/"+slot), current => {
        if (current) { joinIssue = "この宴は満席です。"; return; }
        return { uid: context.user.uid, name, nameKey: key, joinedAt };
      }, { applyLocally: false });
      if (transaction.committed) { joined=true; break; }
    }
    if (!joined) throw Error(joinIssue || "この宴は満席です。");
    roomId = id;
    await startPresence();
    const confirmedRoom=await verifyJoinedRoom(id,context.user.uid,key);
    saveName(name);
    saveRoomSession(confirmedRoom);
    allowAutoResume();
    subscribeRoom(roomId);
    show("multiplayer-waiting");
  } catch (cause) {
    if(joined&&roomId===id&&currentUser?.uid&&key){
      stopPresence();
      try{await removeCurrentPlayer(id,currentUser.uid,key);}catch{}
    }
    roomId="";
    latestRoom=null;
    openedRoom=false;
    error.textContent = cause?.message || "宴に参加できませんでした。";
  }
}

async function startRoom() {
  if (startingRoom || !openedRoom || !roomId || !currentUser?.uid) return;
  startingRoom=true;
  try {
    const presenceSnapshot = await get(ref(window.__firebaseDatabase, roomPresencePath(roomId)));
    const presence = presenceSnapshot.val() || {};
    let transactionIssue = "";
    const transaction = await runTransaction(ref(window.__firebaseDatabase, roomPath(roomId)), current => {
      if (!current || current.status !== "waiting") { transactionIssue = "この宴はすでに開始されています。"; return; }
      if (current.hostUid !== currentUser.uid) { transactionIssue = "主催者だけが宴を開始できます。"; return; }
      const waitingPlayers = playerEntries(current);
      if (waitingPlayers.length < 2 || waitingPlayers.length > 6) { transactionIssue = "参加者は2〜6人必要です。"; return; }
      if (disconnectedPlayers({ ...current, presence }).length) { transactionIssue = "切断中の客人がいるため開始できません。"; return; }
      const joinedPlayers = joinSlotEntries(current);
      const players = { ...(current.players || {}) };
      const nameIndex = { ...(current.nameIndex || {}) };
      joinedPlayers.forEach(player => {
        players[player.uid] = { name: player.name, nameKey: player.nameKey, joinedAt: player.joinedAt };
        nameIndex[player.nameKey] = player.uid;
      });
      const seats = waitingPlayers.map(player => player.uid);
      for (let index = seats.length - 1; index > 0; index--) {
        const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
        [seats[index], seats[other]] = [seats[other], seats[index]];
      }
      return { ...current, players, nameIndex, joinSlots: null, status: "started", startedAt: Date.now(), round: { number: 1, phase: "draw" }, seats, parentUid: seats[0] };
    }, { applyLocally: false });
    if (!transaction.committed) {
      const current = transaction.snapshot?.val();
      if (current) await renderWaiting(withRoomPresence(current));
      else $("#room-waiting-message").textContent = transactionIssue || "宴を開始できませんでした。";
    }
  } catch (error) {
    show("multiplayer-waiting");
    $("#room-waiting-message").textContent = "宴を開始できませんでした。"+(error.message || "");
  } finally {
    startingRoom=false;
  }
}

async function leaveWaitingRoom() {
  if (leavingWaitingRoom) return;
  leavingWaitingRoom = true;
  if (latestRoom?.status === "closed") {
    const returnMode=openedRoom ? "host" : "join";
    clearRoomSession();
    clearInviteUrl();
    openMultiplayerSetup(returnMode);
    leavingWaitingRoom = false;
    return;
  }
  if (openedRoom && latestRoom?.hostUid === currentUser?.uid && latestRoom.status === "waiting") {
    try {
      await update(ref(window.__firebaseDatabase, roomPath(roomId)), { status: "closed", closedAt: Date.now() });
    } catch (cause) {
      $("#room-waiting-message").textContent = `宴を閉じられませんでした。${cause.message || ""}`;
      leavingWaitingRoom = false;
      return;
    }
    clearRoomSession();
    leavingWaitingRoom = false;
    openMultiplayerSetup("host");
    return;
  }
  const id = roomId;
  const uid = currentUser?.uid;
  const player = latestRoom?.players?.[uid];
  const nameKey = player?.nameKey || normalizedName(savedName());
  let failure = null;
  for (let attempt = 1; attempt <= LEAVE_RETRY_COUNT; attempt++) {
    $("#room-waiting-message").textContent = `退出しています…（${attempt}/${LEAVE_RETRY_COUNT}）`;
    try {
      await removeCurrentPlayer(id, uid, nameKey);
      if (await isCurrentPlayerRemoved(id, uid, nameKey)) {
        const returnMode=openedRoom ? "host" : "join";
        clearRoomSession();
        clearInviteUrl();
        openMultiplayerSetup(returnMode);
        leavingWaitingRoom = false;
        return;
      }
      failure = Error("退出情報が残っています。");
    } catch (cause) {
      failure = cause;
    }
    if (attempt < LEAVE_RETRY_COUNT) await wait(LEAVE_RETRY_DELAY_MS);
  }
  $("#room-waiting-message").textContent = `退出できませんでした。もう一度戻るを押してください。${failure?.message ? ` ${failure.message}` : ""}`;
  leavingWaitingRoom = false;
}

async function exitStartedFeast(){const returnMode=openedRoom ? "host" : "join";if(!latestRoom||roomEnded(latestRoom)){clearRoomSession();clearInviteUrl();openMultiplayerSetup(returnMode);return;}await set(ref(window.__firebaseDatabase,`${roomPath(roomId)}/endedBy`),{uid:currentUser.uid,name:latestRoom.players?.[currentUser.uid]?.name||savedName(),at:Date.now()});clearRoomSession();clearInviteUrl();openMultiplayerSetup(returnMode);}
function requestExit(){if(!roomId||!latestRoom||latestRoom.status!=="started")return false;if(roomEnded(latestRoom)){const returnMode=openedRoom ? "host" : "join";clearRoomSession();clearInviteUrl();openMultiplayerSetup(returnMode);return true;}if(confirm("退出すると、この宴は全員終了となります。退出しますか？"))exitStartedFeast().catch(error=>alert(`退出できませんでした。 ${error.message||""}`));return true;}
function showRecoveryError(message){$("#recovery-title").textContent="宴を確認できません";$("#recovery-message").textContent=message;$("#recovery-resume").hidden=true;$("#recovery-retry").hidden=false;show("multiplayer-recovery");}
const inviteRoomId=()=>new URLSearchParams(location.search).get("room")?.trim().toUpperCase()||"";
const hasConnectedPlayer=room=>playerEntries(room).some(player=>Object.keys(room?.presence?.[player.uid]||{}).length>0);
function clearStoredResumeAvailability(){storedResumeAvailable=false;$("#resume-stored-room-choice").hidden=true;}
function clearSetupErrors(){ $("#create-room-error").textContent=""; $("#join-room-error").textContent=""; }
function setSetupMode(mode, { clearInvitation=false, suppressResume=false } = {}) {
  if (clearInvitation) clearInviteUrl();
  if(mode==="single"&&suppressResume)suppressAutoResume();
  setupMode=mode;
  $("#setup-single-device").classList.toggle("is-selected",mode==="single");
  $("#setup-multiplayer").classList.toggle("is-selected",mode==="multiplayer");
  $("#single-device-setup").hidden=mode!=="single";
  $("#multiplayer-setup").hidden=mode!=="multiplayer";
  clearSetupErrors();
  if(mode==="multiplayer"){
    if(!multiplayerModeSelectedInCurrentSetup) multiplayerSetupMode="host";
    multiplayerModeSelectedInCurrentSetup=true;
    setMultiplayerSetupMode(multiplayerSetupMode);
  }
}
function setMultiplayerSetupMode(mode, { clearInvitation=false } = {}) {
  if(clearInvitation) clearInviteUrl();
  multiplayerSetupMode=mode;
  $("#create-room-choice").classList.toggle("is-selected",mode==="host");
  $("#join-room-choice").classList.toggle("is-selected",mode==="join");
  $("#host-form").hidden=mode!=="host";
  $("#join-form").hidden=mode!=="join";
  $("#resume-stored-room-choice").hidden=!storedResumeAvailable;
  clearSetupErrors();
  ensureMultiplayerName();
  if(mode==="host") prepareCreateForm();
}
function openFeastSetup({ mode="single", multiplayerMode="host", restoreSingle=true } = {}) {
  if(mode==="single"&&restoreSingle) window.startSingleDeviceGame?.();
  else show("player-count");
  $("#setup-mode-choice").hidden=false;
  multiplayerModeSelectedInCurrentSetup=mode==="multiplayer";
  multiplayerSetupMode=multiplayerMode;
  setSetupMode(mode);
}
function openMultiplayerSetup(multiplayerMode="host"){openFeastSetup({mode:"multiplayer",multiplayerMode,restoreSingle:false});}
function storedSessionMatchesRoom(room, saved, uid) {
  if (!room || !saved || room.feastId !== saved.feastId || (saved.role === "host") !== (room.hostUid === uid)) return false;
  if (room.status === "waiting") return room.hostUid === uid ? !!room.players?.[uid] : !!joinSlotForUid(room, uid);
  return (room.status === "started" || room.status === "closed") && !!room.players?.[uid] && room.nameIndex?.[room.players[uid].nameKey] === uid;
}
function stopStoredSessionReconnectRetry() {
  storedSessionReconnectUnsubscribe?.();
  storedSessionReconnectUnsubscribe = null;
}
function retryStoredSessionOnReconnect() {
  const saved = storedRoomSession(), database = window.__firebaseDatabase;
  if (!saved || !database || storedSessionReconnectUnsubscribe) return;
  storedSessionReconnectUnsubscribe = onValue(ref(database, ".info/connected"), snapshot => {
    if (snapshot.val() !== true) {
      storedSessionReconnectAttempted = false;
      return;
    }
    if (storedSessionReconnectAttempted) return;
    storedSessionReconnectAttempted = true;
    stopStoredSessionReconnectRetry();
    checkStoredRoomSession();
  }, error => {
    stopStoredSessionReconnectRetry();
    console.warn("保存済みの宴の再接続状態を受信できませんでした。", error);
  });
}
async function checkStoredRoomSession(){
  if (checkingStoredRoomSession) return false;
  checkingStoredRoomSession = true;
  const saved=storedRoomSession(), invitedRoomId=inviteRoomId();
  stopStoredSessionReconnectRetry();
  clearStoredResumeAvailability();
  if(!saved){checkingStoredRoomSession=false;return false;}
  resumeDebug("check:start",{invited:Boolean(invitedRoomId),suppressed:autoResumeSuppressed()});
  try{
    const context=await getFirebaseContext();
    currentUser=context.user;window.__firebaseDatabase=context.database;
    if(context.user.uid!==saved.uid){resumeDebug("check:uid-mismatch");return false;}
    if(!navigator.onLine){resumeDebug("check:offline");retryStoredSessionOnReconnect();return false;}
    await waitForDatabaseConnection(context.database);
    const [roomSnapshot,presenceSnapshot]=await Promise.all([
      get(ref(context.database,roomPath(saved.roomId))),
      get(ref(context.database,roomPresencePath(saved.roomId)))
    ]);
    const room={...(roomSnapshot.val()||{}),presence:presenceSnapshot.val()||{}};
    if(!room){resumeDebug("check:room-missing");retryStoredSessionOnReconnect();return false;}
    const valid=storedSessionMatchesRoom(room,saved,context.user.uid);
    resumeDebug("check:room-read",{status:room.status,phase:room.round?.phase||null,valid,connectedPlayers:playerEntries(room).filter(player=>Object.keys(room?.presence?.[player.uid]||{}).length).length});
    if(!valid){
      const connected=(await get(ref(context.database,".info/connected"))).val()===true;
      resumeDebug("check:session-invalid",{connected});
      if(!connected)retryStoredSessionOnReconnect();
      return false;
    }
    roomId=saved.roomId;openedRoom=saved.role==="host";latestRoom=room;
    if(room.status==="closed"||roomEnded(room)){resumeDebug("check:room-ended",{status:room.status,ended:Boolean(room.endedBy)});clearRoomSession();clearStoredResumeAvailability();return false;}
    if(invitedRoomId){
      if(invitedRoomId!==roomId.toUpperCase())return false;
      await resumeStoredRoom();
      resumeDebug("check:resumed-from-invite");
      storedSessionReconnectAttempted=false;
      return true;
    }
    if(!autoResumeSuppressed()&&hasConnectedPlayer(room)){
      await resumeStoredRoom();
      resumeDebug("check:auto-resumed");
      storedSessionReconnectAttempted=false;
      return true;
    }
    storedResumeAvailable=true;
    resumeDebug("check:resume-choice-required");
    return false;
  }catch(error){
    resumeDebug("check:error",{message:error.message||String(error)});
    console.warn("保存済みの宴を確認できませんでした。",error);
    if (currentUser?.uid === saved.uid) retryStoredSessionOnReconnect();
    return false;
  }finally{
    checkingStoredRoomSession=false;
  }
}
async function resumeStoredRoom(){
  if(!roomId||!currentUser)return;
  const saved=storedRoomSession();
  resumeDebug("resume:start",{phase:latestRoom?.round?.phase||null});
  await startPresence();
  resumeDebug("resume:presence-started");
  const [roomSnapshot,presenceSnapshot]=await Promise.all([
    get(ref(window.__firebaseDatabase,roomPath(roomId))),
    get(ref(window.__firebaseDatabase,roomPresencePath(roomId)))
  ]);
  const room={...(roomSnapshot.val()||{}),presence:presenceSnapshot.val()||{}};
  if(!storedSessionMatchesRoom(room,saved,currentUser.uid)){
    resumeDebug("resume:session-invalid-after-presence");
    stopPresence();
    throw Error("復帰状態を確認できません。");
  }
  allowAutoResume();
  latestRoom=withRoomPresence(room);
  resumeDebug("resume:room-ready",{phase:room.round?.phase||null});
  subscribeRoom(roomId);
  await renderWaiting(withRoomPresence(room));
  resumeDebug("resume:rendered",{phase:room.round?.phase||null});
}
async function resumeStoredRoomFromChoice(){try{await resumeStoredRoom();}catch(error){showRecoveryError(`復帰できませんでした。 ${error.message||""}`);}}
async function exitStoredRoom(){if(!latestRoom||!roomId||!currentUser)return;if(latestRoom.status==="closed"){clearRoomSession();clearInviteUrl();clearStoredResumeAvailability();openMultiplayerSetup("host");return;}if(latestRoom.status==="started"){if(roomEnded(latestRoom)){clearRoomSession();clearInviteUrl();clearStoredResumeAvailability();openMultiplayerSetup("host");return;}if(!confirm("退出すると、この宴は全員終了となります。退出しますか？"))return;await exitStartedFeast();return;}if(latestRoom.status==="waiting"){await startPresence();await leaveWaitingRoom();}}
function openJoinFromUrl() {
  const id = inviteRoomId();
  if (!id) return false;
  openFeastSetup({mode:"multiplayer",multiplayerMode:"join",restoreSingle:false});
  $("#join-room-id").value=id;
  $("#multiplayer-name").value=savedName() || "客人";
  return true;
}

function initialize() {
  if (!enabled()) return;
  $("#recovery-resume").onclick=()=>resumeStoredRoom().catch(error=>{$("#recovery-message").textContent=`復帰できませんでした。 ${error.message||""}`;});
  $("#recovery-exit").onclick=()=>exitStoredRoom().catch(error=>{$("#recovery-message").textContent=`退出できませんでした。 ${error.message||""}`;});
  $("#recovery-retry").onclick=()=>checkStoredRoomSession();
  const style = document.createElement("style");
  style.textContent = ".multiplayer-choice-image{max-width:330px;margin:12px auto 18px}.multiplayer-choice-buttons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.multiplayer-choice-buttons .button{width:100%;padding-inline:8px}.multiplayer-choice-back{margin-top:24px}.copy-field{display:flex;gap:8px;align-items:stretch}.copy-field input{min-width:0;flex:1}.copy-icon-button{flex:0 0 42px;width:42px;min-height:42px;border:0;border-radius:11px;background:#eceff1;color:#263238;font-size:1.3rem;line-height:1;display:grid;place-items:center;cursor:pointer}.room-number-row{display:flex;align-items:center;gap:8px}.room-number-row .copy-icon-button{flex-basis:34px;width:34px;min-height:34px;font-size:1.05rem}.multiplayer-summary{margin:14px 0;padding:12px;border:1px solid #68775c;border-radius:12px;background:#192623}.multiplayer-summary p{margin:5px 0}.invite-qr{display:grid;place-items:center;margin:12px auto}.invite-qr canvas{max-width:100%;height:auto;border-radius:8px}.multiplayer-debug-log{max-height:42vh;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:10px;border:1px solid #68775c;border-radius:8px;background:#101a17;color:#eee8dc;font:12px/1.45 ui-monospace,monospace;text-align:left}";
  document.head.append(style);
  const debugButton=document.createElement("button");
  debugButton.id="multiplayer-resume-debug"; debugButton.className="button button-secondary"; debugButton.type="button"; debugButton.textContent="復帰診断ログ";
  debugButton.hidden=resumeDebugEntries().length===0;
  debugButton.onclick=showResumeDebugLog;
  $("#howto-button").after(debugButton);
  const roundHeader = $("#multiplayer-round-header");
  if (roundHeader && "ResizeObserver" in window) {
    roundHeaderObserver = new ResizeObserver(updateRoundHeaderOffset);
    roundHeaderObserver.observe(roundHeader);
  }
  window.addEventListener("resize", updateRoundHeaderOffset);
  $("#setup-single-device").onclick=()=>setSetupMode("single",{clearInvitation:true,suppressResume:true});
  $("#setup-multiplayer").onclick=()=>setSetupMode("multiplayer");
  $("#create-room-choice").onclick=()=>setMultiplayerSetupMode("host",{clearInvitation:true});
  $("#join-room-choice").onclick=()=>setMultiplayerSetupMode("join");
  $("#resume-stored-room-choice").onclick=resumeStoredRoomFromChoice;
  $("#create-room-back").onclick=()=>{clearInviteUrl();show("title");};
  $("#join-room-back").onclick=()=>{clearInviteUrl();show("title");};
  $("#host-card-set").onchange=refreshHostWordSets;
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

window.multiplayerPhase1 = { isEnabled: enabled, openFeastSetup, openJoinFromUrl, checkStoredRoomSession, requestExit, renderHistory: renderMultiplayerHistory };
initialize();
