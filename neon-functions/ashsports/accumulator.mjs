const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

/**
 * Select a small, distinct-fixture accumulator from already research-qualified
 * real-sport picks. This function does not weaken upstream research gates.
 */
export function buildAccumulator(picks=[], options={}) {
  const target=Number(options.targetOdds)||2;
  const min=Number(options.minOdds)||1.8;
  const max=Number(options.maxOdds)||2.2;
  const maxLegs=Math.max(1,Math.min(4,Number(options.maxLegs)||3));
  const candidates=(picks||[]).filter(p=>{
    const odds=Number(p.price),prob=Number(p.estimated_probability_pct);
    return p && p.research_gate==="approved" && p.availability_research_gate==="approved" &&
      Number.isFinite(odds)&&odds>1&&Number.isFinite(prob)&&prob>0&&prob<100&&
      Number(p.value_edge_pct)>0 && Number(p.evidence_index)>=35;
  }).slice(0,16);
  let best=null;
  function visit(start,legs,odds,logProbability,score){
    if(legs.length){
      if(odds>=min&&odds<=max){
        const closeness=1-Math.abs(Math.log(odds/target));
        const candidate={legs:[...legs],combined_odds:Number(odds.toFixed(3)),
          estimated_combined_probability_pct:Number((Math.exp(logProbability)*100).toFixed(2)),
          score:score+closeness*18};
        if(!best||candidate.score>best.score)best=candidate;
      }
    }
    if(legs.length>=maxLegs)return;
    for(let i=start;i<candidates.length;i++){
      const p=candidates[i],price=Number(p.price),prob=Number(p.estimated_probability_pct)/100;
      if(odds*price>max*1.08)continue;
      // Confidence and edge add modest weight; probability remains the main risk factor.
      const legScore=Math.log(Math.max(prob,0.0001))*10+
        Math.min(20,Number(p.evidence_index)||0)*0.25+
        Math.min(8,Number(p.value_edge_pct)||0)*0.5;
      visit(i+1,[...legs,p],odds*price,logProbability+Math.log(prob),score+legScore);
    }
  }
  visit(0,[],1,0,0);
  if(!best)return {status:"NO_BET",target_odds:target,range:[min,max],
    reason:"No combination of distinct fixtures passed the upstream research gates and target-odds range."};
  return {status:"QUALIFIED",target_odds:target,range:[min,max],...best};
}

export function formatAccumulator(day, accumulator) {
  const header="ASH • REAL FOOTBALL ACCUMULATOR — "+day;
  if(!accumulator||accumulator.status!=="QUALIFIED")return header+"\n\nNO BET — "+(accumulator?.reason||"No qualified accumulator available.");
  const lines=[header,"Target combined odds: "+accumulator.target_odds.toFixed(2),
    "Combined odds: "+accumulator.combined_odds.toFixed(2),
    "Estimated combined probability: "+accumulator.estimated_combined_probability_pct+"% (independence approximation; not a guarantee)",""];
  accumulator.legs.forEach((p,i)=>{
    lines.push((i+1)+". "+p.home_team+" vs "+p.away_team,
      "Pick: "+p.selection+" @ "+Number(p.price).toFixed(2)+" • "+p.best_bookmaker,
      "Estimated chance: "+p.estimated_probability_pct+"% • edge: "+p.value_edge_pct+" pp",
      "Evidence: "+p.evidence_index+"/100 • "+p.bookmakers+" bookmakers");
  });
  lines.push("Only research-approved real fixtures are included. Odds can move; no result is guaranteed.");
  return lines.join("\n");
}
