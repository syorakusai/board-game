export function createRouletteController(){
  const timers=new Set();
  const schedule=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);};
  const clearCards=cards=>cards.forEach(card=>card.classList.remove("reveal-checking","reveal-parent","reveal-flash"));
  const cancel=()=>{timers.forEach(clearTimeout);timers.clear();document.querySelectorAll("#result-votes .vote-card").forEach(card=>card.classList.remove("reveal-checking","reveal-parent","reveal-flash"));};
  const start=({cards,parentIndex,status,summaryEl,next,summary})=>{
    cancel();
    const randomIndex=()=>Math.floor(Math.random()*cards.length);
    const forward=index=>(index+1)%cards.length;
    const backward=index=>(index-1+cards.length)%cards.length;
    const varyDelay=delay=>Math.max(90,Math.round(delay*(0.9+Math.random()*0.2)));
    const rhythmDelay=(delays,step,totalSteps)=>{const position=totalSteps<2?0:step*(delays.length-1)/(totalSteps-1),before=Math.floor(position),after=Math.min(delays.length-1,before+1),ratio=position-before;return varyDelay(delays[before]+(delays[after]-delays[before])*ratio);};
    const stepsTo=(from,to,move)=>{let steps=0,current=from;while(current!==to){current=move(current);steps++;}return steps;};
    const makeRoute=minimumSteps=>{let current=randomIndex(),steps=0;const sequence=[current];while(steps<minimumSteps||current!==parentIndex){current=forward(current);sequence.push(current);steps++;}return sequence;};
    const pattern=delays=>{const sequence=makeRoute(Math.max(6,delays.length-2+Math.floor(Math.random()*5)));return {sequence,delays:sequence.slice(0,-1).map((_,step)=>rhythmDelay(delays,step,sequence.length-1))};};
    const reversePattern=delays=>{let current=randomIndex();const sequence=[current],reverseMarkers=[];const push=(move,count)=>{for(let i=0;i<count;i++){current=move(current);sequence.push(current);}};push(forward,5+Math.floor(Math.random()*4));const decoyIndex=randomIndex();push(backward,stepsTo(current,decoyIndex,backward)||cards.length);reverseMarkers.push(sequence.length-1);push(backward,1+Math.floor(Math.random()*3));push(forward,stepsTo(current,parentIndex,forward)||cards.length);return {sequence,delays:sequence.slice(0,-1).map((_,step)=>{const base=rhythmDelay(delays,step,sequence.length-1);return reverseMarkers.includes(step+1)?Math.round(base*1.9):base;})};};
    const patterns=[()=>pattern([189,216,256,310,378,459,553,674,836,1079]),()=>pattern([198,240,297,368,453,566,707,919,1202]),()=>pattern([181,220,272,337,415,233,324,454,622,829,1063]),()=>pattern([150,180,220,270,330,410,510,640,800,980,1210]),()=>pattern([170,210,260,320,390,480,590,720,870,1040,650]),()=>pattern([140,180,230,290,360,220,330,490,720,1080,1660]),()=>pattern([160,200,250,310,390,490,620,780,980,1230,1090]),()=>pattern([180,220,270,340,430,540,680,850,1060,1280,650]),()=>pattern([150,190,240,300,380,250,360,530,780,1160,2160]),()=>pattern([160,210,270,340,430,540,680,850,1200,190,220,260,320,430,600,850,1450,1000]),()=>reversePattern([160,200,250,320,410,530,690,860,1060,1320,980]),()=>reversePattern([150,190,240,310,400,520,680,870,1110,1380,760]),()=>reversePattern([170,220,280,350,450,580,740,930,1160,1450,1080])];
    const plan=patterns[Math.floor(Math.random()*patterns.length)]();
    const finish=()=>{const parentCard=cards[parentIndex];parentCard.classList.remove("reveal-checking");parentCard.classList.add("reveal-parent");let flashes=0;const flash=()=>{parentCard.classList.toggle("reveal-flash");flashes++;if(flashes>=8){parentCard.classList.remove("reveal-flash");status.textContent="";summaryEl.innerHTML=summary;next.disabled=false;return;}schedule(flash,150);};flash();};
    let step=0;const roulette=()=>{clearCards(cards);const index=plan.sequence[step];cards[index].classList.add("reveal-checking");status.textContent="";if(step===plan.sequence.length-1){finish();return;}const delay=plan.delays[Math.min(step,plan.delays.length-1)];step++;schedule(roulette,delay);};roulette();
  };
  return {start,cancel};
}
