import { CARD_SET_STORAGE_KEY, PLAYER_COUNT_STORAGE_KEY, PLAYER_STORAGE_KEY, WORD_SET_STORAGE_KEY, esc, numberedWordsMarkup, readWordSetSelections, savedCardSet, savedPlayerCount, savedPlayers, shuffle, state } from "./game-state.js";
import { createRouletteController } from "./roulette.js";
import { validateCardSetData } from "./card-data.js";
import { createRoundCandidates, isOfficialWord } from "./round-candidates.js";
import { evaluateRound, nextParentIndex, orderedChildren, scoreRound } from "./game-rules.js";

const multiplayerReady = /\/board-game\/dev(?:\/|$)/.test(location.pathname) ? import("./multiplayer-phase1.js").catch(() => {}) : Promise.resolve();

const rouletteController=createRouletteController();
window.__rouletteController=rouletteController;
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
}
const screens=document.querySelectorAll("[data-screen]");
document.title="貴族のひそめごと";
document.querySelector('[data-screen="title"] .eyebrow')?.remove();
document.querySelector('[data-screen="title"] .title-main-image')?.setAttribute("alt","貴族のひそめごとのメインイラスト");
const fixedScreenTitles={"player-count":"宴の支度","player-names":"客人の名乗り",ready:"宴の席次"};
Object.entries(fixedScreenTitles).forEach(([screen,title])=>{const el=document.querySelector(`[data-screen="${screen}"] h1`);if(el)el.textContent=title;});
const roundTitleMap={"CARD DRAW":"札選び","CARD OPEN":"お題との対面","PARENT WORD":"親のひそめごと","WORD OPEN":"言葉のお披露目",DISCUSSION:"宴の推理","TIME UP":"お時間です","WORD SELECT":"推理結果の記帳","SELECTION OPEN":"ひそめごと開帳",RESULT:"宴の顛末",SCORE:"得点の記録",FINAL:"宴の結び"};
const roundNames=["","第一","第二","第三","第四","第五","第六","第七","第八","第九","第十"];
function roundSeatLabel(round){return `${roundNames[Number(round)]||`第${round}`}席`;}
document.querySelectorAll("[data-round-title]").forEach((title,index)=>{const row=document.createElement("div"),actions=document.createElement("div"),historyButton=document.createElement("button"),menu=document.createElement("div"),menuButton=document.createElement("button"),menuPanel=document.createElement("div"),howtoButton=document.createElement("button"),exitButton=document.createElement("button");row.className="screen-title-row";actions.className="screen-title-actions";historyButton.className="history-button";historyButton.type="button";historyButton.textContent="戦績";historyButton.setAttribute("aria-label","戦績を開く");historyButton.onclick=openHistory;menu.className="game-menu";menuButton.className="menu-button";menuButton.type="button";menuButton.textContent="≡";menuButton.setAttribute("aria-label","メニューを開く");menuButton.setAttribute("aria-expanded","false");menuPanel.className="game-menu-panel is-hidden";menuPanel.id=`game-menu-${index}`;menuButton.setAttribute("aria-controls",menuPanel.id);howtoButton.type="button";howtoButton.textContent="遊び方";howtoButton.onclick=openHowto;exitButton.type="button";exitButton.textContent="退出";exitButton.onclick=()=>{if(window.multiplayerPhase1?.requestExit?.())return;returnToTitle();};menuButton.onclick=e=>{e.stopPropagation();document.querySelectorAll(".game-menu").forEach(item=>{if(item!==menu)item.classList.remove("is-open");item.querySelector(".menu-button")?.setAttribute("aria-expanded","false");});const open=menu.classList.toggle("is-open");menuButton.setAttribute("aria-expanded",String(open));};title.replaceWith(row);row.append(title,actions);menuPanel.append(howtoButton,exitButton);menu.append(menuButton,menuPanel);actions.append(historyButton,menu);});
document.addEventListener("click",e=>{if(!e.target.closest(".game-menu")){document.querySelectorAll(".game-menu.is-open").forEach(menu=>{menu.classList.remove("is-open");menu.querySelector(".menu-button")?.setAttribute("aria-expanded","false");});}});
function show(name){
  state.currentScreen=name;
  screens.forEach(s=>s.classList.toggle("is-hidden",s.dataset.screen!==name));
  window.scrollTo(0,0);
  document.documentElement.scrollTop=0;
  document.body.scrollTop=0;
  requestAnimationFrame(()=>window.scrollTo(0,0));
}
window.showGameScreen = show;
function cardImagePath(image){if(!image)return "";return image.startsWith("cards/")?image:`cards/${state.cardSet}/${image}`;}
function cardMarkup(card){const src=cardImagePath(card?.image);return src?`<img class="card-zoom-trigger" src="${esc(src)}" alt="お題カード。タップで拡大表示" tabindex="0" role="button" onerror="this.parentElement.innerHTML='<div class=&quot;missing-card&quot;>カード画像を読み込めませんでした</div>'">`:`<div class="missing-card">カード画像を読み込めません</div>`;}
const cardLightbox=document.querySelector("#card-lightbox"),cardLightboxContent=document.querySelector("#card-lightbox-content");
function closeCardLightbox(){cardLightbox.classList.add("is-hidden");cardLightboxContent.replaceChildren();document.body.classList.toggle("lightbox-open",historyLightbox&&!historyLightbox.classList.contains("is-hidden"));}
function openCardLightbox(image){cardLightboxContent.innerHTML=`<img src="${esc(image.src)}" alt="${esc(image.alt)}">`;cardLightbox.classList.remove("is-hidden");document.body.classList.add("lightbox-open");document.querySelector("#card-lightbox-close").focus();}
document.addEventListener("click",e=>{
  if(cardLightbox && !cardLightbox.classList.contains("is-hidden") && cardLightbox.contains(e.target)){
    if(e.target.closest("#card-lightbox-close") || e.target.closest("#card-lightbox-content")) closeCardLightbox();
    return;
  }
  const image=e.target.closest(".card-zoom-trigger");
  if(image)openCardLightbox(image);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!cardLightbox.classList.contains("is-hidden"))closeCardLightbox();if((e.key==="Enter"||e.key===" ")&&e.target.matches(".card-zoom-trigger")){e.preventDefault();openCardLightbox(e.target);}});
const historyLightbox=document.querySelector("#history-lightbox");
function historyVoteMarkup(record){const words=Array.isArray(record.words)?record.words:[0,1,2,3].map(index=>record.words?.[String(index)]??"");return words.map((word,index)=>{const voters=Array.isArray(record.children)?record.children.filter(child=>(record.answers[String(child.id)]??"")===word).map(child=>child.name):Object.values(record.answers||{}).filter(answer=>Number(answer?.candidateIndex)===index).map(answer=>answer.name);return `<div class="vote-card${word===record.parentWord?" parent-answer":""}" data-parent-word="${word===record.parentWord}"><div class="word">${esc(word)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function historyEntryMarkup(record){const label=roundSeatLabel(record.round),src=cardImagePath(record.image);return `<article class="history-entry"><div class="history-entry-heading"><h3>${label}</h3></div><div class="history-entry-overview">${src?`<div class="history-card-area"><img class="card-zoom-trigger" src="${esc(src)}" alt="${label}のお題カード。タップで拡大表示" tabindex="0" role="button"></div>`:""}<div class="history-result"><p class="result-parent">親：${esc(record.parentName)}</p><p class="history-summary">${esc(record.summary)}</p></div></div><div class="history-vote-list">${historyVoteMarkup(record)}</div></article>`;}
function renderHistory(){const list=document.querySelector("#history-list"),scores=document.querySelector("#history-scores");if(!list)return;const visibleHistory=state.history.filter(record=>record.round<state.round||(["scores","final"].includes(state.currentScreen)&&record.round===state.round)).sort((a,b)=>b.round-a.round);if(scores)scores.innerHTML=state.players.length?`<p class="history-label">現在のポイント</p><div class="history-score-list">${state.players.map(p=>`<div class="history-score"><span>${esc(p.name)}</span><strong>${p.score}ポイント</strong></div>`).join("")}</div>`:"";list.innerHTML=visibleHistory.length?visibleHistory.map(historyEntryMarkup).join(""):"<p class=\"history-empty\">まだ結果が確定したラウンドはありません。</p>";}
function openHistory(){if(!window.multiplayerPhase1?.renderHistory?.())renderHistory();historyLightbox.classList.remove("is-hidden");document.body.classList.add("lightbox-open");document.querySelector("#history-close").focus();}
function closeHistory(){historyLightbox.classList.add("is-hidden");document.body.classList.toggle("lightbox-open",!cardLightbox.classList.contains("is-hidden"));}
document.querySelector("#history-close").onclick=closeHistory;
historyLightbox.addEventListener("click",e=>{if(e.target===historyLightbox)closeHistory();});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!historyLightbox.classList.contains("is-hidden"))closeHistory();if(e.key==="Escape"){document.querySelectorAll(".game-menu.is-open").forEach(menu=>{menu.classList.remove("is-open");menu.querySelector(".menu-button")?.setAttribute("aria-expanded","false");});}});
function closeRoundOverlays(){
  closeCardLightbox();
  closeHistory();
  document.querySelectorAll(".game-menu.is-open").forEach(menu=>{
    menu.classList.remove("is-open");
    menu.querySelector(".menu-button")?.setAttribute("aria-expanded","false");
  });
  document.body.classList.remove("lightbox-open");
}
function handoff(player,next){document.querySelector("#handoff-text").innerHTML=`全員イラストを確認してください。<br>確認できたら、${esc(player.name)}さんが「確認」を押して親ワード入力へ進んでください。`;document.querySelector("#handoff-card-area").innerHTML=cardMarkup(state.card);state.handoffNext=next;show("handoff");}
function preloadCardImage(card){const src=cardImagePath(card?.image);if(!src)return Promise.resolve();const image=new Image();image.src=src;return new Promise(resolve=>{const done=()=>resolve();image.addEventListener("load",()=>{const decode=image.decode?image.decode().catch(()=>{}):Promise.resolve();decode.finally(done);},{once:true});image.addEventListener("error",done,{once:true});});}
function clearPreparedCard(){state.preparedCard=null;state.cardPreparation=null;}
function prepareCard(){if(state.preparedCard)return state.cardPreparation||Promise.resolve();const cards=state.cards||[];let available=cards.filter(c=>!state.usedCards.has(c.id));if(!available.length){state.usedCards.clear();available=cards;}const card=available[Math.floor(Math.random()*available.length)];const wordSet=state.wordSets.find(set=>set.id===state.wordSet)||state.wordSets[0];const wordCard=wordSet?.cards?.find(c=>String(c.cardId)===String(card.id));state.preparedCard={card,official:shuffle(wordCard?.officialWords||[]).slice(0,3)};state.cardPreparation=preloadCardImage(card);return state.cardPreparation;}
async function chooseCard(){await prepareCard();const prepared=state.preparedCard;if(!prepared)return;state.card=prepared.card;state.official=prepared.official;state.usedCards.add(state.card.id);state.preparedCard=null;state.cardPreparation=null;}
async function fetchCardSet(setId){const r=await fetch(`cards/${setId}/cards.json`);if(!r.ok)throw Error("カードセットを読み込めませんでした。");return validateCardSetData(await r.json(),setId);}
function saveWordSetSelection(){try{const saved=readWordSetSelections();saved[state.cardSet]=state.wordSet;localStorage.setItem(WORD_SET_STORAGE_KEY,JSON.stringify(saved));}catch{}}
function renderWordSetOptions(){const select=document.querySelector("#word-set-select");if(!select)return;const data=state.setCatalog[state.cardSet];const sets=data?.wordSets||[];select.replaceChildren(...sets.map(set=>{const option=document.createElement("option");option.value=set.id;option.textContent=set.name;return option;}));if(!sets.some(set=>set.id===state.wordSet))state.wordSet=sets[0]?.id||"";select.value=state.wordSet;}
function renderCardSetOptions(){const select=document.querySelector("#card-set-select");if(!select)return;select.replaceChildren(...Object.values(state.setCatalog).map(data=>{const option=document.createElement("option");option.value=data.id;option.textContent=data.name;return option;}));if(!state.setCatalog[state.cardSet])state.cardSet=state.defaultCardSet;select.value=state.cardSet;renderWordSetOptions();}
function setCatalogError(message){state.catalogReady=false;document.querySelector("#card-set-error").textContent=message;updatePlayerCountNext();}
async function loadCardSetCatalog(){const response=await fetch("card-sets.json");if(!response.ok)throw Error("カードセット一覧を読み込めませんでした。");const config=await response.json(),ids=config.cardSetIds;if(!Array.isArray(ids)||!ids.length)throw Error("カードセット一覧の形式が正しくありません。");const entries=await Promise.all(ids.map(fetchCardSet));entries.forEach(data=>state.setCatalog[data.id]=data);state.defaultCardSet=state.setCatalog[config.defaultCardSet]?config.defaultCardSet:Object.keys(state.setCatalog)[0];state.catalogReady=true;document.querySelector("#card-set-error").textContent="";renderCardSetOptions();updatePlayerCountNext();}
async function loadCards(){try{const d=state.setCatalog[state.cardSet]||await fetchCardSet(state.cardSet);state.cardSetData=d;state.cards=d.cards;state.wordSets=d.wordSets;const saved=readWordSetSelections()[state.cardSet]||state.wordSet;state.wordSet=state.wordSets.some(set=>set.id===saved)?saved:state.wordSets[0].id;renderWordSetOptions();saveWordSetSelection();}catch{state.cards=[{id:1,image:""}];state.wordSets=[{id:"standard-1",name:"標準セット",cards:[{cardId:1,officialWords:["りんご","鴨","奇妙な組み合わせ"]}]}];state.wordSet="standard-1";}}
function renderOrder(){const list=document.querySelector("#player-list");if(!list)return;list.innerHTML=state.order.map((i,n)=>`<div class="player-item"><span class="player-order"><span class="player-order-number">${n+1}.</span> <span class="player-name">${esc(state.players[i].name)}</span></span></div>`).join("");}
function showReady(){
  state.order=shuffle(state.players.map((_,i)=>i));
  state.parentIndex=0;
  show("ready");
  renderOrder();
  requestAnimationFrame(renderOrder);
}
const playerCountNext=document.querySelector("#player-count-next");
function updatePlayerCountNext(){playerCountNext.disabled=!state.catalogReady||!Number.isInteger(state.playerCount)||state.playerCount<2||state.playerCount>6;}
function readSavedPlayerCount(){try{const n=Number(localStorage.getItem(PLAYER_COUNT_STORAGE_KEY));return Number.isInteger(n)&&n>=2&&n<=6?n:0;}catch{return 0;}}
function setDiscussionMinutes(minutes){state.discussionMinutes=minutes;document.querySelector("#discussion-time-select").value=String(minutes);}
function defaultDiscussionMinutes(playerCount){return playerCount>=5?3:2;}
function restorePlayerCountSelection(){const n=readSavedPlayerCount();state.playerCount=n;const button=[...document.querySelectorAll(".count-button")].find(x=>x.textContent===`${n}人`);document.querySelectorAll(".count-button").forEach(x=>x.classList.toggle("is-selected",x===button));setDiscussionMinutes(defaultDiscussionMinutes(n));updatePlayerCountNext();}
function renderPlayerNames(){
  const n=state.playerCount;
  document.querySelector("#name-description").textContent="客人の名前を入力してください。";
  const f=document.querySelector("#name-fields");
  f.replaceChildren();
  for(let i=0;i<n;i++){
    const l=document.createElement("label");
    l.className="field-label";
    l.innerHTML=`${["一人目","二人目","三人目","四人目","五人目","六人目"][i]}<input name="p${i}" maxlength="20" autocomplete="off" placeholder="客人${i+1}" />`;
    f.append(l);
  }
  [...f.querySelectorAll("input")].forEach((x,i)=>x.value=state.players[i]?.name||savedPlayers[i]||`客人${i+1}`);
  show("player-names");
}
function selectPlayerCount(n,button){
  state.playerCount=n;
  setDiscussionMinutes(defaultDiscussionMinutes(n));
  document.querySelectorAll(".count-button").forEach(x=>x.classList.toggle("is-selected",x===button));
  updatePlayerCountNext();
  try{localStorage.setItem(PLAYER_COUNT_STORAGE_KEY,String(n));}catch{}
}
for(let n=2;n<=6;n++){
  const b=document.createElement("button");
  b.className="count-button";
  b.textContent=`${n}人`;
  b.onclick=()=>selectPlayerCount(n,b);
  document.querySelector("#player-counts").append(b);
}
if(savedPlayerCount)restorePlayerCountSelection();
updatePlayerCountNext();
playerCountNext.onclick=()=>{if(state.playerCount)renderPlayerNames();};
document.querySelector("#player-count-back").onclick=()=>show("title");
document.querySelector("#card-set-select").onchange=e=>{state.cardSet=e.target.value;state.wordSet=readWordSetSelections()[state.cardSet]||"standard-1";try{localStorage.setItem(CARD_SET_STORAGE_KEY,state.cardSet);}catch{}renderWordSetOptions();saveWordSetSelection();updatePlayerCountNext();};
document.querySelector("#word-set-select").onchange=e=>{state.wordSet=e.target.value;saveWordSetSelection();updatePlayerCountNext();};
document.querySelector("#discussion-time-select").onchange=e=>{state.discussionMinutes=Number(e.target.value);};
window.startSingleDeviceGame=()=>{restorePlayerCountSelection();show("player-count");};
document.querySelector("#title-start").onclick=()=>{if(window.multiplayerPhase1?.isEnabled()){window.multiplayerPhase1.openFeastSetup();return;}window.startSingleDeviceGame();};
document.querySelector("#title-start").addEventListener("click",()=>{state.history=[];});
function openHowto(){state.howtoReturnScreen=state.currentScreen;document.querySelectorAll(".game-menu.is-open").forEach(menu=>{menu.classList.remove("is-open");menu.querySelector(".menu-button")?.setAttribute("aria-expanded","false");});show("howto");}
function returnFromHowto(){const destination=state.howtoReturnScreen||"title";state.howtoReturnScreen="title";show(destination);}
document.querySelector("#howto-button").onclick=openHowto;
document.querySelector("#howto-back").onclick=returnFromHowto;
document.querySelector('[data-howto-panel="welcome"] .howto-description p:nth-child(2)').textContent="そこに並ぶのは、カードに用意された3つの公式ワードと、親プレイヤーがひそめた、もう1つのワード。";
function selectHowtoPanel(id){
  document.querySelectorAll("[data-howto-tab]").forEach(tab=>{
    const selected=tab.dataset.howtoTab===id;
    tab.classList.toggle("is-selected",selected);
    tab.setAttribute("aria-selected",String(selected));
  });
  document.querySelectorAll("[data-howto-panel]").forEach(panel=>{
    panel.classList.toggle("is-selected",panel.dataset.howtoPanel===id);
  });
  const content=document.querySelector(".howto-content");
  if(content)content.scrollTop=0;
}
document.querySelectorAll("[data-howto-tab]").forEach(tab=>{
  tab.addEventListener("click",()=>selectHowtoPanel(tab.dataset.howtoTab));
});
document.querySelector("#back-button").onclick=()=>show("player-count");
document.querySelector("#ready-back").onclick=()=>renderPlayerNames();
document.querySelector("#player-form").onsubmit=e=>{e.preventDefault();const names=[...new FormData(e.target).values()].map(v=>String(v).trim()),err=document.querySelector("#form-error");err.textContent="";if(names.some(n=>!n)){err.textContent="すべてのプレイヤー名を入力してください。";return;}if(new Set(names).size!==names.length){err.textContent="プレイヤー名は重複しないようにしてください。";return;}state.gameSession++;clearPreparedCard();state.players=names.map((name,i)=>({id:i,name,score:0}));try{localStorage.setItem(PLAYER_STORAGE_KEY,JSON.stringify(names));}catch{}showReady();};
document.querySelector("#start-button").onclick=async()=>{await loadCards();startRound();};
function setRoundDrawReady(player){document.querySelector("#round-card-message").textContent=`${player.name}さん、伏せ札の山から1枚引いてください。`;document.querySelector("#round-start-button").disabled=false;document.querySelector("#draw-card").textContent="伏せ札を引く";document.querySelector("#draw-status").classList.add("is-hidden");deckStackImage.classList.remove("is-loading");deckStackImage.setAttribute("aria-disabled","false");}
function startRound(){rouletteController.cancel();state.round++;const p=state.players[state.order[state.parentIndex]],roundName=roundNames[state.round]||`第${state.round}`;document.querySelectorAll("[data-round-title]").forEach(x=>x.textContent=`${roundName}席　${roundTitleMap[x.dataset.roundTitle]||x.dataset.roundTitle}`);document.querySelector("#round-title").textContent=`親：${p.name}`;setRoundDrawReady(p);prepareCard();show("round");}
async function drawRoundCard(){const button=document.querySelector("#round-start-button"),gameSession=state.gameSession;if(button.disabled)return;button.disabled=true;document.querySelector("#draw-card").textContent="お題を準備しています…";document.querySelector("#draw-status").classList.remove("is-hidden");deckStackImage.classList.add("is-loading");deckStackImage.setAttribute("aria-disabled","true");await chooseCard();if(gameSession!==state.gameSession)return;document.querySelector("#draw-card").textContent="カードを引きました";document.querySelector("#handoff-card-area").innerHTML=cardMarkup(state.card);handoff(state.players[state.order[state.parentIndex]],"親ワード入力");}
document.querySelector("#round-start-button").onclick=drawRoundCard;
const deckStackImage=document.querySelector("#deck-stack-image");
deckStackImage.onclick=drawRoundCard;
deckStackImage.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();drawRoundCard();}};
document.querySelector("#handoff-button").onclick=()=>{document.querySelector("#parent-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#official-preview").innerHTML=state.official.map(word=>`<div class="word official">${esc(word)}</div>`).join("");document.querySelector("#parent-word").value="";show("parent-input");};
document.querySelector("#handoff-redraw-button").onclick=()=>{const p=state.players[state.order[state.parentIndex]];setRoundDrawReady(p);prepareCard();show("round");};
document.querySelector("#parent-submit").onclick=()=>{const v=document.querySelector("#parent-word").value.trim(),e=document.querySelector("#parent-error");if(!v){e.textContent="親ワードを入力してください。";return;}if(isOfficialWord({officialWords:state.official,parentWord:v})){e.textContent="公式ワードとは別の言葉を入力してください。";return;}e.textContent="";state.parentWord=v;state.parentCandidateId="parent";state.words=shuffle(createRoundCandidates(state.official,v));document.querySelector("#public-card-area").innerHTML=cardMarkup(state.card);show("word-open");};
document.querySelector("#word-open-button").onclick=()=>{document.querySelector("#discussion-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#public-words").innerHTML=numberedWordsMarkup(state.words);show("discussion");startTimer();};
function startTimer(){let left=state.discussionMinutes*60;const el=document.querySelector("#timer");clearInterval(state.timer);const tick=()=>{el.textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,"0")}`;if(left--<=0){clearInterval(state.timer);state.timer=null;closeRoundOverlays();showTimeout();}};tick();state.timer=setInterval(tick,1000);}
document.querySelector("#discussion-end").onclick=startAnswer;
function showTimeout(){document.querySelector("#timeout-card-area").innerHTML=`<img src="assets/time-up-butler.jpg" alt="お時間ですと書かれた額縁を持つ老執事" onerror="this.outerHTML='<div class=&quot;missing-card&quot;>お時間ですの画像を読み込めませんでした</div>'">`;show("timeout");}
document.querySelector("#timeout-to-answer").onclick=startAnswer;
function startAnswer(){clearInterval(state.timer);state.answers={};state.answerIndex=0;state.answerLocked=false;askAnswer();}
function currentRound(){return {players:state.players,order:state.order,parentIndex:state.parentIndex,answers:state.answers,parentCandidateId:state.parentCandidateId};}
function askAnswer(){const children=orderedChildren(state.players,state.order,state.parentIndex);if(state.answerIndex>=children.length){showResultOpen();return;}const answerIndex=state.answerIndex,p=children[answerIndex],submit=document.querySelector("#answer-submit");state.answerLocked=false;state.selectedAnswer="";document.querySelector("#answer-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#answer-title").textContent=`${p.name}さんの回答`;document.querySelector("#answer-words").innerHTML=numberedWordsMarkup(state.words,"button");submit.disabled=true;document.querySelectorAll(".word-button").forEach(b=>b.onclick=()=>{if(state.answerLocked||state.answerIndex!==answerIndex)return;state.selectedAnswer=b.dataset.word;document.querySelectorAll(".word-button").forEach(button=>button.classList.toggle("is-selected",button===b));submit.disabled=false;});submit.onclick=()=>{if(state.answerLocked||state.answerIndex!==answerIndex||!state.selectedAnswer)return;state.answerLocked=true;submit.disabled=true;document.querySelectorAll(".word-button").forEach(button=>button.disabled=true);state.answers[p.id]=state.selectedAnswer;state.answerIndex++;askAnswer();};show("answer");}
function voteMarkup(){return state.words.map(w=>{const voters=state.players.filter((_,i)=>i!==state.order[state.parentIndex]).filter(p=>state.answers[p.id]===w.id).map(p=>p.name);return `<div class="vote-card" data-parent-word="${w.id===state.parentCandidateId}"><div class="word">${esc(w.text)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function selectionMarkup(){return state.words.map(w=>{const voters=state.players.filter((_,i)=>i!==state.order[state.parentIndex]).filter(p=>state.answers[p.id]===w.id).map(p=>p.name);return `<div class="vote-card"><div class="word">${esc(w.text)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function showResultOpen(){document.querySelector("#result-open-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#result-open-description")?.removeAttribute("hidden");document.querySelector("#selection-summary").innerHTML=selectionMarkup();document.querySelector('[data-screen="result-open"]')?.classList.remove("is-multiplayer-reveal");window.__restoreMultiplayerRevealButton?.();show("result-open");}
function handleSingleResultOpen(){document.querySelector("#result-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#result-votes").innerHTML=voteMarkup();const {correct,isTwoPlayer}=evaluateRound(currentRound()),children=orderedChildren(state.players,state.order,state.parentIndex),summary=correct.length===0?(isTwoPlayer?"<strong>子が不正解</strong><span>得点なし</span>":"<strong>全員不正解</strong><span>親：+1ポイント</span>"):correct.length===children.length?(isTwoPlayer?"<strong>子が正解</strong><span>子：+1ポイント</span>":"<strong>全員正解</strong><span>子：全員+1ポイント<br>親：−1ポイント</span>"):"<strong>一部の子が正解</strong><span>正解した子：各+1ポイント</span>",status=document.querySelector("#result-reveal-status"),summaryEl=document.querySelector("#result-summary"),next=document.querySelector("#result-next"),cards=[...document.querySelectorAll("#result-votes .vote-card")];summaryEl.innerHTML="";status.textContent="";next.disabled=true;show("result");cards.forEach(card=>card.classList.remove("reveal-pending","reveal-checking","reveal-parent","reveal-flash"));const parentIndex=cards.findIndex(card=>card.dataset.parentWord==="true");if(parentIndex<0||!cards.length){status.textContent="親のワードを確認できません。";summaryEl.innerHTML=summary;next.disabled=false;return;}rouletteController.start({cards,parentIndex,status,summaryEl,next,summary});}
window.__singleResultOpenHandler=handleSingleResultOpen;
document.querySelector("#result-open-button").addEventListener("click",handleSingleResultOpen);
function finalRoundCards(){
  const cards=state.history.filter(record=>record.image).map(record=>({round:record.round,image:record.image}));
  if(state.card?.image&&!cards.some(card=>card.round===state.round))cards.push({round:state.round,image:state.card.image});
  return cards;
}
function finalCardRecapMarkup(cards){
  const midpoint=(cards.length-1)/2;
  return cards.map((card,index)=>{
    const distance=index-midpoint;
    const x=Math.round(distance*11),y=Math.abs(distance)*3,rotation=(distance*3.1).toFixed(1);
    const miniX=Math.round(distance*24),miniRotation=(distance*5.4).toFixed(1);
    const last=index===cards.length-1?" is-last":"";
    return `<img class="final-recap-card${last}" src="${esc(cardImagePath(card.image))}" alt="${roundSeatLabel(card.round)}のお題カード" style="--entry-delay:${index*300}ms;--card-x:${x}px;--card-y:${y}px;--card-rotate:${rotation}deg;--mini-x:${miniX}px;--mini-rotate:${miniRotation}deg;--stack-order:${index}">`;
  }).join("");
}
function showFinalResults(winners){
  const cards=finalRoundCards(),screen=document.querySelector('[data-screen="final"]'),recap=document.querySelector("#final-card-recap"),revealDelay=cards.length*300+1280;
  recap.innerHTML=finalCardRecapMarkup(cards);
  screen.style.setProperty("--final-reveal-delay",`${revealDelay}ms`);
  document.querySelector("#final-winners").innerHTML=winners.map(player=>`<p>${esc(player.name)}</p>`).join("");
  document.querySelector("#final-score-summary").innerHTML=state.players.map(player=>`<div class="final-score${winners.some(winner=>winner.id===player.id)?" is-winner":""}"><span>${esc(player.name)}</span><strong>${player.score}ポイント</strong></div>`).join("");
  document.querySelector("#final-replay").hidden=true;
  document.querySelector("#multiplayer-final-guidance").hidden=true;
  screen.classList.remove("is-revealed");
  screen.classList.remove("is-revealing");
  show("final");
  void screen.offsetWidth;
  screen.classList.add("is-revealing");
}
window.showMultiplayerFinalResults=(players,winners,cards,{animate=false,cardsChanged=false,presentationChanged=false}={})=>{const screen=document.querySelector('[data-screen="final"]'),recap=document.querySelector("#final-card-recap"),guidance=document.querySelector("#multiplayer-final-guidance"),entering=screen.classList.contains("is-hidden"),revealDelay=cards.length*300+1280;if(animate||cardsChanged){recap.innerHTML=finalCardRecapMarkup(cards);screen.style.setProperty("--final-reveal-delay",`${revealDelay}ms`);}if(animate||presentationChanged){document.querySelector("#final-winners").innerHTML=winners.map(player=>`<p>${esc(player.name)}</p>`).join("");document.querySelector("#final-score-summary").innerHTML=players.map(player=>`<div class="final-score${winners.some(winner=>winner.id===player.id)?" is-winner":""}"><span>${esc(player.name)}</span><strong>${player.score}ポイント</strong></div>`).join("");}document.querySelector("#final-replay").hidden=false;guidance.hidden=false;if(entering)show("final");if(animate){screen.classList.remove("is-revealed","is-revealing");void screen.offsetWidth;screen.classList.add("is-revealing");}else if(cardsChanged){screen.classList.remove("is-revealing");screen.classList.add("is-revealed");}};
function handleSingleResultNext(){const scored=scoreRound(currentRound()),{children,correct}=scored;state.players.forEach((player,index)=>{player.score=scored.players[index].score;});const winners=state.players.filter(p=>p.score>=5);if(winners.length){showFinalResults(winners);return;}document.querySelector("#score-summary").innerHTML=state.players.map(p=>`<div class="player-item"><span>${esc(p.name)}</span><span>${p.score}ポイント</span></div>`).join("");document.querySelector("#score-title").textContent=children.length===1?(correct.length===0?"子が不正解":"子が正解"):(correct.length===0?"全員不正解":correct.length===children.length?"全員正解":"一部の子が正解");const nextRoundButton=document.querySelector("#next-round");nextRoundButton.textContent="次の席へ";nextRoundButton.dataset.action="next-round";show("scores");}
window.__singleResultNextHandler=handleSingleResultNext;
document.querySelector("#result-next").onclick=handleSingleResultNext;
document.querySelector("#result-open-button").addEventListener("click",()=>{document.querySelector("#result-parent").textContent=`親：${state.players[state.order[state.parentIndex]].name}`;});
function recordSingleResultHistory(){if(state.history.some(record=>record.round===state.round))return;const {children,correct}=evaluateRound(currentRound()),summary=correct.length===0?(children.length===1?"子が不正解。得点なし":"全員不正解。親プラス1ポイント"):correct.length===children.length?(children.length===1?"子が正解。子プラス1ポイント":"全員正解。子プラス1ポイント、親マイナス1ポイント"):"一部の子が正解。正解した子に1ポイント",answers=Object.fromEntries(Object.entries(state.answers).map(([id,candidateId])=>[id,state.words.find(candidate=>candidate.id===candidateId)?.text||""]));state.history.push({round:state.round,parentName:state.players[state.order[state.parentIndex]].name,image:state.card?.image||"",parentWord:state.parentWord,words:state.words.map(candidate=>candidate.text),answers,children:children.map(p=>({id:p.id,name:p.name})),summary});}
window.__singleResultHistoryHandler=recordSingleResultHistory;
document.querySelector("#result-next").addEventListener("click",recordSingleResultHistory);
function returnToTitle(){if(!confirm("ゲームを退出してタイトル画面に戻りますか？\n現在のゲーム内容は失われます。"))return;rouletteController.cancel();clearInterval(state.timer);state.gameSession++;clearPreparedCard();Object.assign(state,{playerCount:0,cardSet:state.cardSet,players:[],order:[],parentIndex:0,card:null,official:[],words:[],parentWord:"",answers:{},answerIndex:0,answerLocked:false,selectedAnswer:"",timer:null,usedCards:new Set(),round:0,handoffNext:"",howtoReturnScreen:"title"});show("title");}
function handleSingleNextRound(){if(document.querySelector("#next-round").dataset.action==="title"){returnToTitle();return;}state.parentIndex=nextParentIndex(state.order,state.parentIndex);startRound();}
window.__singleNextRoundHandler=handleSingleNextRound;
document.querySelector("#next-round").onclick=handleSingleNextRound;
document.querySelector("#final-to-title").onclick=returnToTitle;
const GAME_EXIT_MESSAGE="ゲームを終了してタイトル画面に戻りますか？\n現在のゲーム内容は失われます。";
function stopGame(){clearInterval(state.timer);if(confirm(GAME_EXIT_MESSAGE)){location.reload();}}
window.addEventListener("beforeunload",e=>{if(state.round){e.preventDefault();e.returnValue=GAME_EXIT_MESSAGE;}});
history.pushState(null,"",location.href);window.addEventListener("popstate",()=>{history.pushState(null,"",location.href);stopGame();});
loadCardSetCatalog().catch(error=>setCatalogError(error.message||"カードセット一覧を読み込めませんでした。")).finally(()=>multiplayerReady.finally(async()=>{
  const recovering=await window.multiplayerPhase1?.checkStoredRoomSession?.();
  if(!recovering&&!window.multiplayerPhase1?.openJoinFromUrl?.()&&state.currentScreen==="title")show("title");
}));
