export function createRouletteController(){
  const timers=new Set();
  let activeCards=[];
  const schedule=(callback,delay)=>{
    const timer=setTimeout(()=>{timers.delete(timer);callback();},Math.max(0,delay));
    timers.add(timer);
  };
  const clearCards=cards=>cards.forEach(card=>card.classList.remove("reveal-checking","reveal-parent","reveal-flash"));
  const cancel=()=>{
    timers.forEach(clearTimeout);
    timers.clear();
    clearCards(activeCards);
    activeCards=[];
  };
  const randomIndex=count=>Math.floor(Math.random()*count);
  const forward=(index,count)=>(index+1)%count;
  const backward=(index,count)=>(index-1+count)%count;
  const varyDelay=delay=>Math.max(90,Math.round(delay*(0.9+Math.random()*0.2)));
  const rhythmDelay=(delays,step,totalSteps)=>{
    const position=totalSteps<2?0:step*(delays.length-1)/(totalSteps-1);
    const before=Math.floor(position);
    const after=Math.min(delays.length-1,before+1);
    const ratio=position-before;
    return varyDelay(delays[before]+(delays[after]-delays[before])*ratio);
  };
  const stepsTo=(from,to,move,count)=>{
    let steps=0,current=from;
    while(current!==to&&steps<=count){current=move(current,count);steps++;}
    return steps;
  };
  const makeRoute=(count,parentIndex,minimumSteps)=>{
    let current=randomIndex(count),steps=0;
    const sequence=[current];
    while(steps<minimumSteps||current!==parentIndex){
      current=forward(current,count);
      sequence.push(current);
      steps++;
    }
    return sequence;
  };
  const pattern=(count,parentIndex,delays)=>{
    const sequence=makeRoute(count,parentIndex,Math.max(6,delays.length-2+Math.floor(Math.random()*5)));
    return {sequence,delays:sequence.slice(0,-1).map((_,step)=>rhythmDelay(delays,step,sequence.length-1))};
  };
  const reversePattern=(count,parentIndex,delays)=>{
    let current=randomIndex(count);
    const sequence=[current],reverseMarkers=[];
    const push=(move,countToMove)=>{
      for(let i=0;i<countToMove;i++){current=move(current,count);sequence.push(current);}
    };
    push(forward,5+Math.floor(Math.random()*4));
    const decoyIndex=randomIndex(count);
    push(backward,stepsTo(current,decoyIndex,backward,count)||count);
    reverseMarkers.push(sequence.length-1);
    push(backward,1+Math.floor(Math.random()*3));
    push(forward,stepsTo(current,parentIndex,forward,count)||count);
    return {sequence,delays:sequence.slice(0,-1).map((_,step)=>{
      const base=rhythmDelay(delays,step,sequence.length-1);
      return reverseMarkers.includes(step+1)?Math.round(base*1.9):base;
    })};
  };
  const createPlan=({count,parentIndex})=>{
    const patterns=[
      ()=>pattern(count,parentIndex,[189,216,256,310,378,459,553,674,836,1079]),
      ()=>pattern(count,parentIndex,[198,240,297,368,453,566,707,919,1202]),
      ()=>pattern(count,parentIndex,[181,220,272,337,415,233,324,454,622,829,1063]),
      ()=>pattern(count,parentIndex,[150,180,220,270,330,410,510,640,800,980,1210]),
      ()=>pattern(count,parentIndex,[170,210,260,320,390,480,590,720,870,1040,650]),
      ()=>pattern(count,parentIndex,[140,180,230,290,360,220,330,490,720,1080,1660]),
      ()=>pattern(count,parentIndex,[160,200,250,310,390,490,620,780,980,1230,1090]),
      ()=>pattern(count,parentIndex,[180,220,270,340,430,540,680,850,1060,1280,650]),
      ()=>pattern(count,parentIndex,[150,190,240,300,380,250,360,530,780,1160,2160]),
      ()=>pattern(count,parentIndex,[160,210,270,340,430,540,680,850,1200,190,220,260,320,430,600,850,1450,1000]),
      ()=>reversePattern(count,parentIndex,[160,200,250,320,410,530,690,860,1060,1320,980]),
      ()=>reversePattern(count,parentIndex,[150,190,240,310,400,520,680,870,1110,1380,760]),
      ()=>reversePattern(count,parentIndex,[170,220,280,350,450,580,740,930,1160,1450,1080])
    ];
    const selected=patterns[Math.floor(Math.random()*patterns.length)]();
    const durationMs=selected.delays.reduce((sum,delay)=>sum+delay,0)+1200;
    return {...selected,parentIndex,durationMs};
  };
  const playPlan=({cards,parentIndex,plan,status,summaryEl,next,summary,elapsedMs=0,canEnable=()=>true,onComplete=()=>{}})=>{
    cancel();
    activeCards=cards;
    const sequence=Array.isArray(plan?.sequence)?plan.sequence:[];
    const delays=Array.isArray(plan?.delays)?plan.delays:[];
    if(!sequence.length||sequence.some(index=>!Number.isInteger(index)||index<0||index>=cards.length)||delays.length!==sequence.length-1){
      status.textContent="ルーレット情報を確認できません。";
      summaryEl.innerHTML=summary;
      next.disabled=!canEnable();
      onComplete();
      return;
    }
    const movementDuration=delays.reduce((sum,delay)=>sum+Number(delay||0),0);
    const totalDuration=Number(plan.durationMs)||movementDuration+1200;
    const safeElapsed=Math.max(0,Number(elapsedMs)||0);
    const showStep=step=>{
      clearCards(cards);
      cards[sequence[Math.min(step,sequence.length-1)]].classList.add("reveal-checking");
      status.textContent="";
    };
    const finish=remaining=>{
      const parentCard=cards[parentIndex];
      clearCards(cards);
      parentCard.classList.add("reveal-parent");
      let flashes=Math.max(0,Math.floor((1200-Math.max(0,remaining))/150));
      const flash=()=>{
        parentCard.classList.toggle("reveal-flash");
        flashes++;
        if(flashes>=8){
          parentCard.classList.remove("reveal-flash");
          status.textContent="";
          summaryEl.innerHTML=summary;
          next.disabled=!canEnable();
          onComplete();
          return;
        }
        schedule(flash,150);
      };
      if(remaining>=1200){summaryEl.innerHTML=summary;next.disabled=!canEnable();onComplete();return;}
      for(let index=0;index<flashes;index++)parentCard.classList.toggle("reveal-flash");
      schedule(flash,Math.max(0,150-(Math.max(0,remaining)%150)));
    };
    if(safeElapsed>=totalDuration){clearCards(cards);cards[parentIndex].classList.add("reveal-parent");summaryEl.innerHTML=summary;next.disabled=!canEnable();onComplete();return;}
    if(safeElapsed>=movementDuration){clearCards(cards);cards[parentIndex].classList.add("reveal-parent");finish(safeElapsed-movementDuration);return;}
    let elapsed=0,step=0;
    while(step<delays.length&&elapsed+Number(delays[step])<=safeElapsed){elapsed+=Number(delays[step]);step++;}
    showStep(step);
    schedule(()=>{
      let currentStep=step;
      const advance=()=>{
        if(currentStep>=sequence.length-1){finish(0);return;}
        currentStep++;
        showStep(currentStep);
        schedule(advance,delays[currentStep]||0);
      };
      advance();
    },Math.max(0,elapsed+Number(delays[step]||0)-safeElapsed));
  };
  const start=({cards,parentIndex,status,summaryEl,next,summary})=>{
    const plan=createPlan({count:cards.length,parentIndex});
    playPlan({cards,parentIndex,plan,status,summaryEl,next,summary});
    return plan;
  };
  return {start,cancel,createPlan,playPlan};
}
