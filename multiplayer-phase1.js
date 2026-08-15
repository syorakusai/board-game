import { getFirebaseContext } from "./firebase-client.js";
import { get, onDisconnect, onValue, push, ref, remove, set, update } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

const ROOM_PREFIX = "rooms";
const NAME_STORAGE_KEY = "board-game:dev:multiplayer-name";
const ROOM_SESSION_STORAGE_KEY = "board-game:dev:multiplayer-room-session";
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
let presenceUnsubscribe = null;
let activeConnectionRef = null;
let secretUnsubscribe = null;
let parentSecret = null;

const $ = selector => document.querySelector(selector);
const roomPath = id => `${ROOM_PREFIX}/${id}`;
const secretPath = (id, roundNumber, uid) => `roomSecrets/${id}/rounds/${roundNumber}/${uid}`;
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
const roomEnded=room=>Boolean(room?.endedBy);
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
  const snapshot=await get(ref(window.__firebaseDatabase,roomPath(id)));
  const room=snapshot.val();
  if(room?.status==="waiting"&&room.players?.[uid]?.nameKey===nameKey&&room.nameIndex?.[nameKey]===uid&&Object.keys(room.presence?.[uid]||{}).length)return room;
  throw Error("参加状態を確認できません。");
}

function stopPresence(){presenceUnsubscribe?.();presenceUnsubscribe=null;if(activeConnectionRef){onDisconnect(activeConnectionRef).cancel().catch(()=>{});remove(activeConnectionRef).catch(()=>{});activeConnectionRef=null;}}
function startPresence(){if(!window.__firebaseDatabase||!roomId||!currentUser?.uid)return Promise.reject(Error("接続状態を開始できません。"));stopPresence();const connections=ref(window.__firebaseDatabase,`${roomPath(roomId)}/presence/${currentUser.uid}`);return new Promise((resolve,reject)=>{let first=true;presenceUnsubscribe=onValue(ref(window.__firebaseDatabase,".info/connected"),async snapshot=>{if(snapshot.val()!==true){activeConnectionRef=null;return;}const connection=push(connections);try{await onDisconnect(connection).remove();await set(connection,true);activeConnectionRef=connection;if(first){first=false;resolve();}}catch(error){if(first){first=false;reject(error);}else console.error("接続状態を再登録できませんでした。",error);}},error=>{if(first){first=false;reject(error);}});});}
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

function renderPlayerBar(room, screenName="round") {
  const header=$("#multiplayer-round-header"),bar=$("#multiplayer-player-bar"),shell=$(".app-shell");
  if(!header||!bar||!shell||!room?.seats){hideRoundHeader();return;}
  const entries=playerEntries(room),disconnected=new Set(disconnectedPlayers(room).map(player=>player.uid));
  bar.innerHTML=room.seats.map(uid=>{const player=entries.find(item=>item.uid===uid)||{name:"不明"};const label=uid===currentUser?.uid?"あなた":disconnected.has(uid)?"切断中":"待機中";return `<div class="multiplayer-player${uid===room.parentUid?" is-parent":""}"><strong>${uid===room.parentUid?"親　":""}${escape(player.name)}</strong><span>0点</span><small>${label}</small></div>`;}).join("");
  placeRoundTitleInHeader(screenName);
  header.classList.remove("is-hidden");shell.classList.add("has-multiplayer-round-header");updateRoundHeaderOffset();
}
async function renderWaiting(room) {
  latestRoom = room;
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
    setSecretSubscription(room);
    if (room.round?.phase === "word-open") enterWordOpenScreen(room);
    else if (room.round?.phase === "parent-word") enterParentWordScreen(room);
    else enterDrawScreen(room);
  }
}

function roundLabel(room) { return `第${["","一","二","三","四","五","六","七","八","九","十"][Number(room?.round?.number || 1)] || Number(room?.round?.number || 1)}席`; }
function multiplayerCardMarkup(image) {
  return image ? `<img class="card-zoom-trigger" src="${escape(image)}" alt="お題カード。タップで拡大表示">` : `<div class="missing-card">カード画像を読み込めません</div>`;
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
function setSecretSubscription(room) {
  secretUnsubscribe?.(); secretUnsubscribe = null; parentSecret = null;
  if (room?.parentUid !== currentUser?.uid || !room?.round?.number) return;
  secretUnsubscribe = onValue(ref(window.__firebaseDatabase, secretPath(roomId, currentRoundNumber(room), currentUser.uid)), snapshot => {
    parentSecret = snapshot.val();
    if (latestRoom?.round?.phase === "parent-word") enterParentWordScreen(latestRoom);
  });
}
function enterDrawScreen(room) {
  const isParent=room.parentUid===currentUser?.uid,parentName=playerEntries(room).find(player=>player.uid===room.parentUid)?.name||"親",disconnected=disconnectedPlayers(room);
  show("round"); renderPlayerBar(room, "round");const title=roundTitleRow("round")?.querySelector("[data-round-title]");if(title)title.textContent=`${roundLabel(room)}　札選び`;$("#round-title").textContent="";$("#round-card-message").textContent=isParent?"あなたが親です。伏せ札の山から1枚引いてください。":"親が札を選んでいます。お待ちください。";
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else if(disconnected.length)setRoundMessage(`${disconnected.map(player=>player.name).join("、")}が切断中。復帰待ち`);
  else setRoundMessage(`ようこそ、宴がはじまりました。第一席の親は${parentName}さんです。${parentName}さん、伏せ札の山から１枚引いてください。`);
  const enabled=canProgress(room)&&isParent;
  $("#round-start-button").disabled=!enabled;$("#draw-card").textContent=roomEnded(room)?"宴はお開きです":disconnected.length?"復帰を待っています":isParent?"伏せ札を引く":"親を待っています";
  $("#round-start-button").onclick=drawMultiplayerCard;
  $("#deck-stack-image").onclick=drawMultiplayerCard;
  $("#deck-stack-image").onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();drawMultiplayerCard();}};
}
function enterParentWordScreen(room) {
  const isParent=room.parentUid===currentUser?.uid, disconnected=disconnectedPlayers(room), card=room.round;
  show("parent-input"); renderPlayerBar(room, "parent-input");
  const title=roundTitleRow("parent-input")?.querySelector("[data-round-title]"); if(title)title.textContent=`${roundLabel(room)}　親のひそめごと`;
  $("#parent-card-area").innerHTML=multiplayerCardMarkup(card?.cardImage);
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
  $("#parent-submit").textContent=hasConfirmedWord?"言葉をお披露目する":"ひそめる";
  $("#parent-redraw-button").disabled=!isParent||!canProgress(room);
  $("#parent-redraw-button").hidden=!isParent;
  $("#parent-error").textContent="";
  if(roomEnded(room))setRoundMessage(`${room.endedBy.name}が退出したため、宴はお開きとなります。右上メニューの「退出」から退出してください。`);
  else if(disconnected.length)setRoundMessage(`${disconnected.map(player=>player.name).join("、")}が切断中。復帰待ち`);
  else setRoundMessage(isParent?(hasConfirmedWord?"親ワードをひそめました。4つの言葉をお披露目してください。":ready?"公式ワード3個を確認し、親ワードをひそめてください。":"親専用の札情報を読み込んでいます。 "):"親がひそめごとを考えています。お待ちください。");
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
  } catch(error) { $("#round-card-message").textContent=`札を引けませんでした。${error.message||""}`; button.disabled=false; $("#draw-card").textContent="伏せ札を引く"; }
}
async function redrawMultiplayerCard() {
  const room=latestRoom;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  try { await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"draw",cardId:null,cardImage:null}); }
  catch(error) { $("#parent-error").textContent=`札を引き直せませんでした。${error.message||""}`; }
}
async function submitParentWord() {
  const room=latestRoom, value=$("#parent-word").value.trim();
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  if(!value){$("#parent-error").textContent="親ワードを入力してください。";return;}
  if(parentSecret?.officialWords?.includes(value)){$("#parent-error").textContent="公式ワードとは別の言葉を入力してください。";return;}
  try {
    await update(ref(window.__firebaseDatabase,secretPath(roomId,currentRoundNumber(room),currentUser.uid)),{parentWord:value,parentWordConfirmedAt:Date.now()});
    parentSecret={...(parentSecret||{}),parentWord:value};
    await publishParentWords();
  }
  catch(error) { $("#parent-error").textContent=`親ワードをひそめられませんでした。${error.message||""}`; }
}
async function publishParentWords() {
  const room=latestRoom, secret=parentSecret;
  if(!room||room.parentUid!==currentUser?.uid||room.round?.phase!=="parent-word"||!canProgress(room))return;
  if(!Array.isArray(secret?.officialWords)||!secret?.parentWord){$("#parent-error").textContent="親ワードを確認できません。";return;}
  try {
    const publicWords=shuffledWords([...secret.officialWords,secret.parentWord]);
    await update(ref(window.__firebaseDatabase,`${roomPath(roomId)}/round`),{phase:"word-open",publicWords});
  } catch(error) { $("#parent-error").textContent=`言葉をお披露目できませんでした。${error.message||""}`; }
}
function subscribeRoom(id) {
  roomUnsubscribe?.();
  roomUnsubscribe = onValue(
    ref((window.__firebaseDatabase), roomPath(id)),
    snapshot => renderWaiting(snapshot.val()).catch(error => {
      show("multiplayer-waiting");
      $("#room-waiting-message").textContent = `宴の状態を表示できませんでした。${error.message || ""}`;
    }),
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
  roomUnsubscribe?.();
  roomUnsubscribe = null;
  secretUnsubscribe?.();
  secretUnsubscribe = null;
  parentSecret = null;
  stopPresence();
  latestRoom = null;
  roomId = "";
  openedRoom = false;
  forgetRoomSession();
  hideRoundHeader();
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function removeCurrentPlayer(id, uid, nameKey) {
  await update(ref(window.__firebaseDatabase, roomPath(id)), {
    [`players/${uid}`]: null,
    [`nameIndex/${nameKey}`]: null
  });
}

async function isCurrentPlayerRemoved(id, uid, nameKey) {
  const snapshot = await get(ref(window.__firebaseDatabase, roomPath(id)));
  const room = snapshot.val();
  return !room?.players?.[uid] && !room?.nameIndex?.[nameKey];
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
    hostUid: context.user.uid, feastId: crypto.randomUUID(), status: "waiting", createdAt: Date.now(),
    cardSet: cardSet.id, cardSetName: cardSet.name, wordSet: wordSet.id, wordSetName: wordSet.name,
    discussionMinutes: Number($("#host-discussion-time").value),
    players: { [context.user.uid]: { name, nameKey: key, joinedAt: Date.now() } },
    nameIndex: { [key]: context.user.uid }
  };
  try { await update(ref(context.database, roomPath(roomId)), room); saveName(name); saveRoomSession(room); await startPresence(); subscribeRoom(roomId); show("multiplayer-waiting"); }
  catch (cause) { error.textContent = `部屋を作成できませんでした。${cause.message || ""}`; }
}

async function joinRoom() {
  const error = $("#join-room-error"); error.textContent = "";
  const id = $("#join-room-id").value.trim().toUpperCase();
  const name = $("#join-name").value.trim();
  if (!id || !name) { error.textContent = "部屋番号と客人名を入力してください。"; return; }
  let joined=false;
  let key="";
  try {
    const context = await getFirebaseContext();
    currentUser = context.user; window.__firebaseDatabase = context.database; openedRoom = false;
    await waitForDatabaseConnection(context.database);
    const snapshot = await get(ref(context.database, roomPath(id)));
    const room = snapshot.val();
    if (!room) throw Error("部屋番号が見つかりません。");
    if (room.status !== "waiting") throw Error(room.status === "closed" ? "この宴は主催者により閉じられました。" : "この宴はすでに開始されています。");
    if (playerEntries(room).length >= 6) throw Error("この宴は満席です。");
    key = normalizedName(name);
    if (room.nameIndex?.[key] && room.nameIndex[key] !== context.user.uid) throw Error("同じ名前の客人がすでに参加しています。別の名前を入力してください。");
    await update(ref(context.database, roomPath(id)), {
      [`players/${context.user.uid}`]: { name, nameKey: key, joinedAt: Date.now() },
      [`nameIndex/${key}`]: context.user.uid
    });
    joined=true;
    roomId = id;
    await startPresence();
    const confirmedRoom=await verifyJoinedRoom(id,context.user.uid,key);
    saveName(name);
    saveRoomSession(confirmedRoom);
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
  if (!openedRoom || !roomId || !currentUser?.uid) return;
  const snapshot = await get(ref(window.__firebaseDatabase, roomPath(roomId)));
  const room = snapshot.val();
  if (!room || room.status !== "waiting" || room.hostUid !== currentUser.uid) return;
  const players = playerEntries(room);
  if (players.length < 2 || players.length > 6 || disconnectedPlayers(room).length) {
    await renderWaiting(room);
    return;
  }
  const seats = [...players.map(player => player.uid)];
  for (let index = seats.length - 1; index > 0; index--) { const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1); [seats[index], seats[other]] = [seats[other], seats[index]]; }
  try {
    await update(ref(window.__firebaseDatabase, roomPath(roomId)), {
      status: "started",
      startedAt: Date.now(),
      round: { number: 1, phase: "draw" },
      seats,
      parentUid: seats[0]
    });
  } catch (error) {
    show("multiplayer-waiting");
    $("#room-waiting-message").textContent = `宴を開始できませんでした。${error.message || ""}`;
  }
}

async function leaveWaitingRoom() {
  if (leavingWaitingRoom) return;
  leavingWaitingRoom = true;
  if (latestRoom?.status === "closed") {
    clearRoomSession();
    clearInviteUrl();
    show("multiplayer-role");
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
    openCreate();
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
        clearRoomSession();
        clearInviteUrl();
        show("multiplayer-role");
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

async function exitStartedFeast(){if(!latestRoom||roomEnded(latestRoom)){clearRoomSession();clearInviteUrl();show("multiplayer-role");return;}await set(ref(window.__firebaseDatabase,`${roomPath(roomId)}/endedBy`),{uid:currentUser.uid,name:latestRoom.players?.[currentUser.uid]?.name||savedName(),at:Date.now()});clearRoomSession();clearInviteUrl();show("multiplayer-role");}
function requestExit(){if(!roomId||!latestRoom||latestRoom.status!=="started")return false;if(roomEnded(latestRoom)){clearRoomSession();clearInviteUrl();show("multiplayer-role");return true;}if(confirm("退出すると、この宴は全員終了となります。退出しますか？"))exitStartedFeast().catch(error=>alert(`退出できませんでした。 ${error.message||""}`));return true;}
function showRecoveryError(message){$("#recovery-title").textContent="宴を確認できません";$("#recovery-message").textContent=message;$("#recovery-resume").hidden=true;$("#recovery-retry").hidden=false;show("multiplayer-recovery");}
function showRecoveryPrompt(room){latestRoom=room;const closed=room.status==="closed";$("#recovery-title").textContent=closed?"主催者が宴を閉じました":roomEnded(room)?"お開きとなった宴があります":"宴に復帰しますか";$("#recovery-message").textContent=closed?"この宴には復帰できません。退出してください。":roomEnded(room)?"終了時点の画面と戦績を確認できます。":room.status==="waiting"?"待機室へ復帰できます。":"中断した宴へ復帰できます。";$("#recovery-resume").hidden=closed;$("#recovery-retry").hidden=true;show("multiplayer-recovery");}
async function checkStoredRoomSession(){const saved=storedRoomSession();if(!saved)return false;try{const context=await getFirebaseContext();currentUser=context.user;window.__firebaseDatabase=context.database;if(context.user.uid!==saved.uid){showRecoveryError("保存されている参加情報と、この端末の認証情報が一致しません。もう一度確認してください。");return true;}const room=(await get(ref(context.database,roomPath(saved.roomId)))).val();const valid=room&&room.feastId===saved.feastId&&room.players?.[context.user.uid]&&(saved.role==="host")===(room.hostUid===context.user.uid)&&(room.status==="waiting"||room.status==="started"||room.status==="closed");if(!valid){showRecoveryError("復帰できる宴を確認できませんでした。通信状態を確認して、もう一度確認してください。");return true;}roomId=saved.roomId;openedRoom=saved.role==="host";showRecoveryPrompt(room);return true;}catch(error){showRecoveryError(`状態を確認できませんでした。 ${error.message||""}`);return true;}}
async function resumeStoredRoom(){if(!latestRoom||!roomId||!currentUser)return;await startPresence();subscribeRoom(roomId);await renderWaiting(latestRoom);}
async function exitStoredRoom(){if(!latestRoom||!roomId||!currentUser)return;if(latestRoom.status==="closed"){clearRoomSession();clearInviteUrl();show("multiplayer-role");return;}if(latestRoom.status==="started"){if(roomEnded(latestRoom)){clearRoomSession();clearInviteUrl();show("multiplayer-role");return;}if(!confirm("退出すると、この宴は全員終了となります。退出しますか？"))return;await exitStartedFeast();return;}if(latestRoom.status==="waiting"){await startPresence();await leaveWaitingRoom();}}

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
  $("#recovery-resume").onclick=()=>resumeStoredRoom().catch(error=>{$("#recovery-message").textContent=`復帰できませんでした。 ${error.message||""}`;});
  $("#recovery-exit").onclick=()=>exitStoredRoom().catch(error=>{$("#recovery-message").textContent=`退出できませんでした。 ${error.message||""}`;});
  $("#recovery-retry").onclick=()=>checkStoredRoomSession();
  const style = document.createElement("style");
  style.textContent = ".multiplayer-choice-image{max-width:330px;margin:12px auto 18px}.multiplayer-choice-buttons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.multiplayer-choice-buttons .button{width:100%;padding-inline:8px}.multiplayer-choice-back{margin-top:24px}.copy-field{display:flex;gap:8px;align-items:stretch}.copy-field input{min-width:0;flex:1}.copy-icon-button{flex:0 0 42px;width:42px;min-height:42px;border:0;border-radius:11px;background:#eceff1;color:#263238;font-size:1.3rem;line-height:1;display:grid;place-items:center;cursor:pointer}.room-number-row{display:flex;align-items:center;gap:8px}.room-number-row .copy-icon-button{flex-basis:34px;width:34px;min-height:34px;font-size:1.05rem}.multiplayer-summary{margin:14px 0;padding:12px;border:1px solid #68775c;border-radius:12px;background:#192623}.multiplayer-summary p{margin:5px 0}.invite-qr{display:grid;place-items:center;margin:12px auto}.invite-qr canvas{max-width:100%;height:auto;border-radius:8px}";
  document.head.append(style);
  const roundHeader = $("#multiplayer-round-header");
  if (roundHeader && "ResizeObserver" in window) {
    roundHeaderObserver = new ResizeObserver(updateRoundHeaderOffset);
    roundHeaderObserver.observe(roundHeader);
  }
  window.addEventListener("resize", updateRoundHeaderOffset);
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

window.multiplayerPhase1 = { isEnabled: enabled, openModeChoice: () => show("mode-choice"), openJoinFromUrl, checkStoredRoomSession, requestExit };
initialize();
