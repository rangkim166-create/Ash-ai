const normalize = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const participantHasSignal = (text,name,kind) => {
 const body=normalize(text),needle=normalize(name);
 if(!needle)return false;
 let at=body.indexOf(needle);
 while(at>=0){
  const before=body.slice(Math.max(0,at-65),at).trim();
  const after=body.slice(at+needle.length,at+needle.length+65).trim();
  if(kind==="support"){
   if(/\\b(?:back(?:s|ed)?|favour(?:s|ed)?|favor(?:s|ed)?|tip(?:s|ped)?|pick(?:s|ed)?|predict(?:s|ed)?|winner is|win for)\\s*$/.test(before))return true;
   if(/^(?:(?:is|are|to be)\\s+)?(?:the\\s+)?(?:favo[u]?rite|pick|tip|winner|to win|will win|wins|victory|to beat|will beat|beats|backed to win)\\b/.test(after))return true;
  }else{
   if(/\\b(?:unlikely to win|not to win|will lose|to lose|avoid|will be beaten|defeat|loss|no value|do not back|don t back)\\s*$/.test(before))return true;
   if(/^(?:(?:is|are)\\s+)?(?:unlikely to win|not to win|to lose|will lose|will be beaten|to be beaten)\\b/.test(after))return true;
  }
  at=body.indexOf(needle,at+needle.length);
 }
 return false;
};


export function assessExpertConsensus(pick, pages=[]) {
 const selected=String(pick?.selection||"").trim(),home=String(pick?.home_team||"").trim(),away=String(pick?.away_team||"").trim();
 const isHome=normalize(selected)===normalize(home),isAway=normalize(selected)===normalize(away);
 if(!selected||(!isHome&&!isAway)) return {decision:"INSUFFICIENT",confidence:0,tipsterConsensus:"Not established",contraryViews:"Not established",teamNews:"Not assessed",reason:"Only exact home-team or away-team selections can be assessed by this consensus rule.",supportingSources:[],contrarySources:[]};
 const opponent=isHome?away:home,support=new Map(),against=new Map(),now=Date.now();
 for(const page of Array.isArray(pages)?pages:[]) {
  const domain=String(page?.domain||"").toLowerCase().replace(/^www\./,"").trim(),date=Date.parse(page?.publishedAt||page?.date||"");
  if(!domain||domain==="unknown"||!Number.isFinite(date)||now-date>10*86400000||date>now+86400000) continue;
  const body=String(page?.title||"")+" "+String(page?.excerpt||"");
  const supports=signalNear(body,selected,positive);
  const opposes=signalNear(body,selected,negative)||signalNear(body,opponent,positive);
  if(supports&&!opposes) support.set(domain,{domain,title:String(page.title||"").slice(0,180),date:page.date||null});
  if(opposes) against.set(domain,{domain,title:String(page.title||"").slice(0,180),date:page.date||null});
 }
 const supportingSources=[...support.values()],contrarySources=[...against.values()],conflict=contrarySources.length>0;
 const decision=supportingSources.length>=2&&!conflict?"SUPPORT":contrarySources.length>=2?"CONFLICT":"INSUFFICIENT";
 const confidence=decision==="SUPPORT"?Math.min(90,70+(supportingSources.length-2)*5):decision==="CONFLICT"?70:0;
 return {decision,confidence,tipsterConsensus:supportingSources.length?supportingSources.length+" independent recent source(s) explicitly contain supportive prediction language for "+selected:"No independent source explicitly supports "+selected,contraryViews:contrarySources.length?contrarySources.length+" independent source(s) contain contrary or opposing prediction language":"No explicit contrary prediction found in the reviewed source text",teamNews:"Team news is assessed separately from expert-prediction consensus.",reason:decision==="SUPPORT"?"At least two independent, recent sources explicitly support the exact selection, with no detected contrary source.":decision==="CONFLICT"?"Conflicting prediction language was detected; the selection is held.":"Fewer than two independent recent sources explicitly support the exact selection. News headlines and bookmaker prices do not count as expert consensus.",supportingSources,contrarySources};
}
