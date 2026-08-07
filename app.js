const PLAYER_STORAGE_KEY = "word-card-players";
const PLAYER_COUNT_STORAGE_KEY = "word-card-player-count";
const CARD_SET_STORAGE_KEY = "word-card-set";
const WORD_SET_STORAGE_KEY = "word-card-word-sets";
const savedPlayers = (() => { try { const v=JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY)||"[]"); return Array.isArray(v)?v.map(String):[]; } catch { return []; } })();
const savedPlayerCount = (() => { try { const v=Number(localStorage.getItem(PLAYER_COUNT_STORAGE_KEY)); return Number.isInteger(v)&&v>=2&&v<=6?v:0; } catch { return 0; } })();
const savedCardSet = (() => { try { const v=localStorage.getItem(CARD_SET_STORAGE_KEY); return v==="test"||v==="vol1"?v:"vol1"; } catch { return "vol1"; } })();
function readWordSetSelections(){try{const v=JSON.parse(localStorage.getItem(WORD_SET_STORAGE_KEY)||"{}");return v&&typeof v==="object"&&!Array.isArray(v)?v:{};}catch{return {};}}
const savedWordSets = readWordSetSelections();
const state = { playerCount:0, cardSet:savedCardSet, wordSet:savedWordSets[savedCardSet]||"standard-1", setCatalog:{}, cardSetData:null, wordSets:[], players:[], order:[], parentIndex:0, card:null, official:[], words:[], parentWord:"", answers:{}, answerIndex:0, answerLocked:false, selectedAnswer:"", timer:null, usedCards:new Set(), round:0, handoffNext:"", history:[] };
const screens=document.querySelectorAll("[data-screen]");
document.title="貴族のひそめごと";
document.querySelector('[data-screen="title"] .eyebrow')?.remove();
document.querySelector('[data-screen="title"] .title-main-image')?.setAttribute("alt","貴族のひそめごとのメインイラスト");
const fixedScreenTitles={howto:"遊び方","player-count":"宴の支度","player-names":"客人の名乗り",ready:"宴の席次"};
Object.entries(fixedScreenTitles).forEach(([screen,title])=>{const el=document.querySelector(`[data-screen="${screen}"] h1`);if(el)el.textContent=title;});
const roundTitleMap={"CARD DRAW":"札選び","CARD OPEN":"お題との対面","PARENT WORD":"親のひそめごと","WORD OPEN":"言葉のお披露目",DISCUSSION:"宴の推理","TIME UP":"お時間です","WORD SELECT":"推理結果の記帳","SELECTION OPEN":"ひそめごと開帳",RESULT:"宴の顛末",SCORE:"得点の記録"};
const roundNames=["","第一","第二","第三","第四","第五","第六","第七","第八","第九","第十"];
document.querySelectorAll("[data-round-title]").forEach(title=>{const row=document.createElement("div"),actions=document.createElement("div"),historyButton=document.createElement("button"),exit=document.createElement("button");row.className="screen-title-row";actions.className="screen-title-actions";historyButton.className="history-button";historyButton.type="button";historyButton.textContent="履歴";historyButton.setAttribute("aria-label","ラウンド履歴を開く");historyButton.onclick=openHistory;exit.className="exit-button";exit.type="button";exit.textContent="退出";exit.setAttribute("aria-label","ゲームを退出してタイトル画面へ戻る");exit.onclick=returnToTitle;title.parentNode.insertBefore(row,title);row.append(title,actions);actions.append(historyButton,exit);});
function show(name){
  screens.forEach(s=>s.classList.toggle("is-hidden",s.dataset.screen!==name));
  window.scrollTo(0,0);
  document.documentElement.scrollTop=0;
  document.body.scrollTop=0;
  requestAnimationFrame(()=>window.scrollTo(0,0));
}
const esc=v=>String(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const shuffle=a=>{const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;};
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
function historyVoteMarkup(record){return record.words.map(word=>{const voters=record.children.filter(child=>(record.answers[String(child.id)]??"")===word).map(child=>child.name);return `<div class="vote-card${word===record.parentWord?" parent-answer":""}" data-parent-word="${word===record.parentWord}"><div class="word">${esc(word)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function historyEntryMarkup(record){const src=cardImagePath(record.image);return `<article class="history-entry"><div class="history-entry-heading"><h3>第${record.round}席</h3></div><div class="history-entry-overview">${src?`<div class="history-card-area"><img class="card-zoom-trigger" src="${esc(src)}" alt="第${record.round}席のお題カード。タップで拡大表示" tabindex="0" role="button"></div>`:""}<div class="history-result"><p class="result-parent">親：${esc(record.parentName)}</p><p class="history-summary">${esc(record.summary)}</p></div></div><div class="history-vote-list">${historyVoteMarkup(record)}</div></article>`;}
function renderHistory(){const list=document.querySelector("#history-list"),scores=document.querySelector("#history-scores");if(!list)return;const visibleHistory=state.history.filter(record=>record.round<state.round).sort((a,b)=>b.round-a.round);if(scores)scores.innerHTML=state.players.length?`<p class="history-label">現在のポイント</p><div class="history-score-list">${state.players.map(p=>`<div class="history-score"><span>${esc(p.name)}</span><strong>${p.score}ポイント</strong></div>`).join("")}</div>`:"";list.innerHTML=visibleHistory.length?visibleHistory.map(historyEntryMarkup).join(""):"<p class=\"history-empty\">まだ結果が確定したラウンドはありません。</p>";}
function openHistory(){renderHistory();historyLightbox.classList.remove("is-hidden");document.body.classList.add("lightbox-open");document.querySelector("#history-close").focus();}
function closeHistory(){historyLightbox.classList.add("is-hidden");document.body.classList.toggle("lightbox-open",!cardLightbox.classList.contains("is-hidden"));}
document.querySelector("#history-close").onclick=closeHistory;
historyLightbox.addEventListener("click",e=>{if(e.target===historyLightbox)closeHistory();});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!historyLightbox.classList.contains("is-hidden"))closeHistory();});
function handoff(player,next){document.querySelector("#handoff-text").innerHTML=`全員イラストを確認してください。<br>確認できたら、${esc(player.name)}さんが「確認」を押して親ワード入力へ進んでください。`;document.querySelector("#handoff-card-area").innerHTML=cardMarkup(state.card);state.handoffNext=next;show("handoff");}
function preloadCardImage(){const src=cardImagePath(state.card?.image);if(src){const image=new Image();image.src=src;}}
function chooseCard(){const cards=state.cards||[];let available=cards.filter(c=>!state.usedCards.has(c.id));if(!available.length){state.usedCards.clear();available=cards;}state.card=available[Math.floor(Math.random()*available.length)];state.usedCards.add(state.card.id);const wordSet=state.wordSets.find(set=>set.id===state.wordSet)||state.wordSets[0];const wordCard=wordSet?.cards?.find(c=>String(c.cardId)===String(state.card.id));state.official=shuffle(wordCard?.officialWords||[]).slice(0,3);preloadCardImage();}
async function fetchCardSet(setId){const r=await fetch(`cards/${setId}/cards.json`);if(!r.ok)throw Error();const d=await r.json();if(!d||!Array.isArray(d.cards)||!Array.isArray(d.wordSets)||!d.cards.length||!d.wordSets.length)throw Error();return d;}
function saveWordSetSelection(){try{const saved=readWordSetSelections();saved[state.cardSet]=state.wordSet;localStorage.setItem(WORD_SET_STORAGE_KEY,JSON.stringify(saved));}catch{}}
function renderWordSetOptions(){const select=document.querySelector("#word-set-select");if(!select)return;const data=state.setCatalog[state.cardSet];const sets=data?.wordSets||[];select.replaceChildren(...sets.map(set=>{const option=document.createElement("option");option.value=set.id;option.textContent=set.name;return option;}));if(!sets.some(set=>set.id===state.wordSet))state.wordSet=sets[0]?.id||"standard-1";select.value=state.wordSet;}
function renderCardSetOptions(){const select=document.querySelector("#card-set-select");if(!select)return;select.replaceChildren(...Object.values(state.setCatalog).map(data=>{const option=document.createElement("option");option.value=data.id;option.textContent=data.name;return option;}));if(!state.setCatalog[state.cardSet])state.cardSet=Object.keys(state.setCatalog)[0]||"vol1";select.value=state.cardSet;renderWordSetOptions();}
async function loadCardSetCatalog(){const entries=await Promise.all(["test","vol1"].map(async id=>{try{return await fetchCardSet(id);}catch{return null;}}));entries.filter(Boolean).forEach(data=>{state.setCatalog[data.id]=data;});renderCardSetOptions();}
async function loadCards(){try{const d=state.setCatalog[state.cardSet]||await fetchCardSet(state.cardSet);state.cardSetData=d;state.cards=d.cards;state.wordSets=d.wordSets;const saved=readWordSetSelections()[state.cardSet]||state.wordSet;state.wordSet=state.wordSets.some(set=>set.id===saved)?saved:state.wordSets[0].id;renderWordSetOptions();saveWordSetSelection();}catch{state.cards=[{id:1,image:""}];state.wordSets=[{id:"standard-1",name:"標準セット",cards:[{cardId:1,officialWords:["りんご","鴨","奇妙な組み合わせ"]}]}];state.wordSet="standard-1";}}
function renderOrder(){const list=document.querySelector("#player-list");if(!list)return;list.innerHTML=state.order.map((i,n)=>`<div class="player-item"><span>${n+1}. ${esc(state.players[i].name)}</span></div>`).join("");}
function showReady(){
  state.order=shuffle(state.players.map((_,i)=>i));
  state.parentIndex=0;
  show("ready");
  renderOrder();
  requestAnimationFrame(renderOrder);
}
const playerCountNext=document.querySelector("#player-count-next");
function updatePlayerCountNext(){playerCountNext.disabled=!Number.isInteger(state.playerCount)||state.playerCount<2||state.playerCount>6;}
function readSavedPlayerCount(){try{const n=Number(localStorage.getItem(PLAYER_COUNT_STORAGE_KEY));return Number.isInteger(n)&&n>=2&&n<=6?n:0;}catch{return 0;}}
function restorePlayerCountSelection(){const n=readSavedPlayerCount();state.playerCount=n;const button=[...document.querySelectorAll(".count-button")].find(x=>x.textContent===`${n}人`);document.querySelectorAll(".count-button").forEach(x=>x.classList.toggle("is-selected",x===button));updatePlayerCountNext();}
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
  [...f.querySelectorAll("input")].forEach((x,i)=>x.value=savedPlayers[i]||`客人${i+1}`);
  show("player-names");
}
function selectPlayerCount(n,button){
  state.playerCount=n;
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
document.querySelector("#card-set-select").onchange=e=>{state.cardSet=e.target.value;state.wordSet=readWordSetSelections()[state.cardSet]||"standard-1";try{localStorage.setItem(CARD_SET_STORAGE_KEY,state.cardSet);}catch{}renderWordSetOptions();saveWordSetSelection();updatePlayerCountNext();};
document.querySelector("#word-set-select").onchange=e=>{state.wordSet=e.target.value;saveWordSetSelection();updatePlayerCountNext();};
document.querySelector("#title-start").onclick=()=>{restorePlayerCountSelection();show("player-count");};
document.querySelector("#title-start").addEventListener("click",()=>{state.history=[];});
function selectHowtoTab(target){
  document.querySelectorAll("[data-howto-tab]").forEach(button=>{
    const selected=button.dataset.howtoTab===target;
    button.classList.toggle("is-selected",selected);
    button.setAttribute("aria-selected",String(selected));
  });
  document.querySelectorAll("[data-howto-panel]").forEach(panel=>panel.classList.toggle("is-selected",panel.dataset.howtoPanel===target));
  document.querySelector(".howto-content").scrollTop=0;
}
document.querySelector("#howto-button").onclick=()=>{selectHowtoTab("welcome");show("howto");};
document.querySelector("#howto-back").onclick=()=>show("title");
document.querySelectorAll("[data-howto-tab]").forEach(tab=>tab.onclick=()=>{
  selectHowtoTab(tab.dataset.howtoTab);
});
document.querySelector("#back-button").onclick=()=>show("player-count");
document.querySelector("#player-form").onsubmit=e=>{e.preventDefault();const names=[...new FormData(e.target).values()].map(v=>String(v).trim()),err=document.querySelector("#form-error");err.textContent="";if(names.some(n=>!n)){err.textContent="すべてのプレイヤー名を入力してください。";return;}if(new Set(names).size!==names.length){err.textContent="プレイヤー名は重複しないようにしてください。";return;}state.players=names.map((name,i)=>({id:i,name,score:0}));try{localStorage.setItem(PLAYER_STORAGE_KEY,JSON.stringify(names));}catch{}showReady();};
document.querySelector("#start-button").onclick=async()=>{await loadCards();startRound();};
function startRound(){state.round++;const p=state.players[state.order[state.parentIndex]],roundName=roundNames[state.round]||`第${state.round}`;document.querySelectorAll("[data-round-title]").forEach(x=>x.textContent=`${roundName}席　${roundTitleMap[x.dataset.roundTitle]||x.dataset.roundTitle}`);document.querySelector("#round-title").textContent=`親：${p.name}`;document.querySelector("#round-card-message").textContent=`${p.name}さん、伏せ札の山から1枚引いてください。`;document.querySelector("#round-start-button").disabled=false;document.querySelector("#draw-card").textContent="伏せ札を引く";show("round");}
document.querySelector("#round-start-button").onclick=()=>{chooseCard();document.querySelector("#round-start-button").disabled=true;document.querySelector("#draw-card").textContent="カードを引きました";document.querySelector("#handoff-card-area").innerHTML=cardMarkup(state.card);handoff(state.players[state.order[state.parentIndex]],"親ワード入力");};
document.querySelector("#handoff-button").onclick=()=>{document.querySelector("#parent-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#official-preview").innerHTML=state.official.map(w=>`<div class="word official">${esc(w)}</div>`).join("");document.querySelector("#parent-word").value="";show("parent-input");};
document.querySelector("#handoff-redraw-button").onclick=()=>{const p=state.players[state.order[state.parentIndex]];document.querySelector("#round-start-button").disabled=false;document.querySelector("#draw-card").textContent="伏せ札を引く";document.querySelector("#round-card-message").textContent=`${p.name}さん、伏せ札の山から1枚引いてください。`;show("round");};
document.querySelector("#parent-submit").onclick=()=>{const v=document.querySelector("#parent-word").value.trim(),e=document.querySelector("#parent-error");if(!v){e.textContent="親ワードを入力してください。";return;}e.textContent="";state.parentWord=v;state.words=shuffle([...state.official,v]);document.querySelector("#public-card-area").innerHTML=cardMarkup(state.card);show("word-open");};
document.querySelector("#word-open-button").onclick=()=>{const words=state.words.map(w=>`<div class="word">${esc(w)}</div>`).join("");document.querySelector("#discussion-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#public-words").innerHTML=words;show("discussion");startTimer();};
function startTimer(){let left=120;const el=document.querySelector("#timer");clearInterval(state.timer);const tick=()=>{el.textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,"0")}`;if(left--<=0){clearInterval(state.timer);showTimeout();}};tick();state.timer=setInterval(tick,1000);}
document.querySelector("#discussion-end").onclick=startAnswer;
function showTimeout(){document.querySelector("#timeout-card-area").innerHTML=`<img src="assets/time-up-butler.png" alt="お時間ですと書かれた額縁を持つ老執事" onerror="this.outerHTML='<div class=&quot;missing-card&quot;>お時間ですの画像を読み込めませんでした</div>'">`;show("timeout");}
document.querySelector("#timeout-to-answer").onclick=startAnswer;
function startAnswer(){clearInterval(state.timer);state.answers={};state.answerIndex=0;state.answerLocked=false;askAnswer();}
function askAnswer(){const orderedChildren=[...state.order.slice(state.parentIndex+1),...state.order.slice(0,state.parentIndex)];const children=orderedChildren.map(i=>state.players[i]);if(state.answerIndex>=children.length){showResultOpen();return;}const answerIndex=state.answerIndex,p=children[answerIndex],submit=document.querySelector("#answer-submit");state.answerLocked=false;state.selectedAnswer="";document.querySelector("#answer-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#answer-title").textContent=`${p.name}さんの回答`;document.querySelector("#answer-words").innerHTML=state.words.map(w=>`<button class="word word-button" data-word="${esc(w)}">${esc(w)}</button>`).join("");submit.disabled=true;document.querySelectorAll(".word-button").forEach(b=>b.onclick=()=>{if(state.answerLocked||state.answerIndex!==answerIndex)return;state.selectedAnswer=b.dataset.word;document.querySelectorAll(".word-button").forEach(button=>button.classList.toggle("is-selected",button===b));submit.disabled=false;});submit.onclick=()=>{if(state.answerLocked||state.answerIndex!==answerIndex||!state.selectedAnswer)return;state.answerLocked=true;submit.disabled=true;document.querySelectorAll(".word-button").forEach(button=>button.disabled=true);state.answers[p.id]=state.selectedAnswer;state.answerIndex++;askAnswer();};show("answer");}
function voteMarkup(){return state.words.map(w=>{const voters=state.players.filter((_,i)=>i!==state.order[state.parentIndex]).filter(p=>state.answers[p.id]===w).map(p=>p.name);return `<div class="vote-card" data-parent-word="${w===state.parentWord}"><div class="word">${esc(w)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function selectionMarkup(){return state.words.map(w=>{const voters=state.players.filter((_,i)=>i!==state.order[state.parentIndex]).filter(p=>state.answers[p.id]===w).map(p=>p.name);return `<div class="vote-card"><div class="word">${esc(w)}</div><div class="vote-count">${voters.length}票</div><div class="voters">${voters.length?voters.map(esc).join("、"):"選択者なし"}</div></div>`;}).join("");}
function showResultOpen(){document.querySelector("#result-open-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#selection-summary").innerHTML=selectionMarkup();show("result-open");}
document.querySelector("#result-open-button").onclick=()=>{document.querySelector("#result-card-area").innerHTML=cardMarkup(state.card);document.querySelector("#result-votes").innerHTML=voteMarkup();const children=state.players.filter((_,i)=>i!==state.order[state.parentIndex]),correct=children.filter(p=>state.answers[p.id]===state.parentWord),isTwoPlayer=children.length===1,summary=correct.length===0?(isTwoPlayer?"<strong>子が不正解</strong><span>得点なし</span>":"<strong>全員不正解</strong><span>親：+1ポイント</span>"):correct.length===children.length?(isTwoPlayer?"<strong>子が正解</strong><span>子：+1ポイント</span>":"<strong>全員正解</strong><span>子：全員+1ポイント<br>親：−1ポイント</span>"):"<strong>一部の子が正解</strong><span>正解した子：各+1ポイント</span>",status=document.querySelector("#result-reveal-status"),summaryEl=document.querySelector("#result-summary"),next=document.querySelector("#result-next"),cards=[...document.querySelectorAll("#result-votes .vote-card")];summaryEl.innerHTML="";status.textContent="";next.disabled=true;show("result");cards.forEach(card=>card.classList.remove("reveal-pending","reveal-checking","reveal-parent","reveal-flash"));const parentIndex=cards.findIndex(card=>card.dataset.parentWord==="true");if(parentIndex<0||!cards.length){status.textContent="親のワードを確認できません。";summaryEl.innerHTML=summary;next.disabled=false;return;}const forward=(from,count)=>Array.from({length:count},(_,i)=>(from+i)%cards.length);const backward=(from,count)=>Array.from({length:count},(_,i)=>(from-i+cards.length)%cards.length);const beforeParent=(offset=1)=>(parentIndex-offset+cards.length)%cards.length;const stretchDelays=(delays,target=4950)=>{const total=delays.reduce((sum,delay)=>sum+delay,0);let remaining=target;return delays.map((delay,index)=>{const adjusted=index===delays.length-1?remaining:Math.round(delay*target/total);remaining-=adjusted;return adjusted;});};const patterns=[
  ()=>({sequence:[...forward((parentIndex+1)%cards.length,cards.length*2+2),parentIndex],delays:stretchDelays([140,160,190,230,280,340,410,500,620,800])}),
  ()=>({sequence:[...forward((parentIndex+2)%cards.length,cards.length+3),...backward(beforeParent(1),2),parentIndex],delays:stretchDelays([140,170,210,260,320,400,500,650,850])}),
  ()=>({sequence:[...forward((parentIndex+1)%cards.length,cards.length*2),...forward(beforeParent(2),3),parentIndex],delays:stretchDelays([140,170,210,260,320,180,250,350,480,640,820])})
];const plan=patterns[Math.floor(Math.random()*patterns.length)]();const finish=()=>{const parentCard=cards[parentIndex];parentCard.classList.remove("reveal-checking");parentCard.classList.add("reveal-parent");let flashes=0;const flash=()=>{parentCard.classList.toggle("reveal-flash");flashes++;if(flashes>=8){parentCard.classList.remove("reveal-flash");status.textContent="";summaryEl.innerHTML=summary;next.disabled=false;return;}setTimeout(flash,150);};flash();};let step=0;const roulette=()=>{cards.forEach(card=>card.classList.remove("reveal-checking","reveal-parent","reveal-flash"));const index=plan.sequence[step];cards[index].classList.add("reveal-checking");status.textContent="";if(step===plan.sequence.length-1){finish();return;}const delay=plan.delays[Math.min(step,plan.delays.length-1)];step++;setTimeout(roulette,delay);};roulette();};
document.querySelector("#result-next").onclick=()=>{const children=state.players.filter((_,i)=>i!==state.order[state.parentIndex]),correct=children.filter(p=>state.answers[p.id]===state.parentWord),parent=state.players[state.order[state.parentIndex]];if(!correct.length){if(children.length>1)parent.score++;}else if(correct.length===children.length){if(children.length>1)parent.score--;children.forEach(p=>p.score++);}else correct.forEach(p=>p.score++);document.querySelector("#score-summary").innerHTML=state.players.map(p=>`<div class="player-item"><span>${esc(p.name)}</span><span>${p.score}ポイント</span></div>`).join("");const winners=state.players.filter(p=>p.score>=5),nextRoundButton=document.querySelector("#next-round");document.querySelector("#score-title").textContent=winners.length?`勝利：${winners.map(p=>esc(p.name)).join("、")}`:(children.length===1?(correct.length===0?"子が不正解":"子が正解"):(correct.length===0?"全員不正解":correct.length===children.length?"全員正解":"一部の子が正解"));nextRoundButton.textContent=winners.length?"タイトルへ":"次の席へ";nextRoundButton.dataset.action=winners.length?"title":"next-round";show("scores");};
document.querySelector("#result-open-button").addEventListener("click",()=>{document.querySelector("#result-parent").textContent=`親：${state.players[state.order[state.parentIndex]].name}`;});
document.querySelector("#result-next").addEventListener("click",()=>{if(state.history.some(record=>record.round===state.round))return;const children=state.players.filter((_,i)=>i!==state.order[state.parentIndex]),correct=children.filter(p=>state.answers[p.id]===state.parentWord),summary=correct.length===0?(children.length===1?"子が不正解。得点なし":"全員不正解。親プラス1ポイント"):correct.length===children.length?(children.length===1?"子が正解。子プラス1ポイント":"全員正解。子プラス1ポイント、親マイナス1ポイント"):"一部の子が正解。正解した子に1ポイント";state.history.push({round:state.round,parentName:state.players[state.order[state.parentIndex]].name,image:state.card?.image||"",parentWord:state.parentWord,words:[...state.words],answers:{...state.answers},children:children.map(p=>({id:p.id,name:p.name})),summary});});
function returnToTitle(){if(!confirm("ゲームを退出してタイトル画面に戻りますか？\n現在のゲーム内容は失われます。"))return;clearInterval(state.timer);Object.assign(state,{playerCount:0,cardSet:state.cardSet,players:[],order:[],parentIndex:0,card:null,official:[],words:[],parentWord:"",answers:{},answerIndex:0,answerLocked:false,selectedAnswer:"",timer:null,usedCards:new Set(),round:0,handoffNext:""});show("title");}
document.querySelector("#next-round").onclick=()=>{if(document.querySelector("#next-round").dataset.action==="title"){returnToTitle();return;}state.parentIndex=(state.parentIndex+1)%state.order.length;startRound();};
const GAME_EXIT_MESSAGE="ゲームを終了してタイトル画面に戻りますか？\n現在のゲーム内容は失われます。";
function stopGame(){clearInterval(state.timer);if(confirm(GAME_EXIT_MESSAGE)){location.reload();}}
window.addEventListener("beforeunload",e=>{if(state.round){e.preventDefault();e.returnValue=GAME_EXIT_MESSAGE;}});
history.pushState(null,"",location.href);window.addEventListener("popstate",()=>{history.pushState(null,"",location.href);stopGame();});
loadCardSetCatalog().then(()=>show("title"));
