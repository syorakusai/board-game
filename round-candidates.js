export const createRoundCandidates=(official,parent)=>[...official.map((text,index)=>({id:`official-${index}`,text})),{id:"parent",text:parent}];
export const isOfficialWord=({officialWords,parentWord})=>officialWords.includes(parentWord);
export const candidateText=(candidates,id)=>candidates.find(c=>c.id===id)?.text||"";
