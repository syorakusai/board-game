export const PLAYER_STORAGE_KEY = "word-card-players";
export const PLAYER_COUNT_STORAGE_KEY = "word-card-player-count";
export const CARD_SET_STORAGE_KEY = "word-card-set";
export const WORD_SET_STORAGE_KEY = "word-card-word-sets";

export const savedPlayers = (() => { try { const v=JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY)||"[]"); return Array.isArray(v)?v.map(String):[]; } catch { return []; } })();
export const savedPlayerCount = (() => { try { const v=Number(localStorage.getItem(PLAYER_COUNT_STORAGE_KEY)); return Number.isInteger(v)&&v>=2&&v<=6?v:0; } catch { return 0; } })();
export const savedCardSet = (() => { try { return localStorage.getItem(CARD_SET_STORAGE_KEY)||""; } catch { return ""; } })();
export function readWordSetSelections(){try{const v=JSON.parse(localStorage.getItem(WORD_SET_STORAGE_KEY)||"{}");return v&&typeof v==="object"&&!Array.isArray(v)?v:{};}catch{return {};}}

const savedWordSets = readWordSetSelections();
export const state = { playerCount:0, discussionMinutes:2, cardSet:savedCardSet, defaultCardSet:"", wordSet:savedWordSets[savedCardSet]||"", setCatalog:{}, cardSetData:null, wordSets:[], catalogReady:false, players:[], order:[], parentIndex:0, card:null, official:[], words:[], parentWord:"", parentCandidateId:"", answers:{}, answerIndex:0, answerLocked:false, selectedAnswer:"", timer:null, usedCards:new Set(), preparedCard:null, cardPreparation:null, gameSession:0, round:0, handoffNext:"", history:[], currentScreen:"title", howtoReturnScreen:"title" };

export const esc=v=>String(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
export const numberedWordsMarkup=(words,tag="div")=>words.map((word,index)=>{const text=typeof word==="string"?word:word.text,id=typeof word==="string"?word:word.id;return `<${tag} class="word${tag==="button"?" word-button":""}"${tag==="button"?` data-word="${esc(id)}"`:""}><span class="word-number" aria-hidden="true">${index+1}</span><span class="word-text">${esc(text)}</span></${tag}>`;}).join("");
export const shuffle=a=>{const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;};
