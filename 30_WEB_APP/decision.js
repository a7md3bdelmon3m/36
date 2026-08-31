/** KIMA EIS deterministic decision-support engine.
 * Converts explicitly supplied measurements + approved thresholds into
 * traceable decision cards. It never invents thresholds and never actuates.
 */
const STATES = Object.freeze(['NORMAL','WATCH','INVESTIGATE','CRITICAL','DATA_INSUFFICIENT']);
const PRIORITY = Object.freeze({NORMAL:'LOW',WATCH:'MEDIUM',INVESTIGATE:'HIGH',CRITICAL:'URGENT',DATA_INSUFFICIENT:'HIGH'});
const CONFIDENCE = Object.freeze({UNREVIEWED:0.45,OBSERVED:0.65,VALIDATED:0.95,REJECTED:0.05,SUPERSEDED:0.2,CONFLICTED:0.25,INFERRED:0.55});

function numeric(v){
  if(v===null || v===undefined || v==='') return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}

function evaluateObservation(observation){
  const value=numeric(observation?.value);
  const t=observation?.observation_context?.thresholds || {};
  const min=numeric(t.min), max=numeric(t.max), cmin=numeric(t.critical_min), cmax=numeric(t.critical_max);
  if(value===null || (min===null && max===null && cmin===null && cmax===null)){
    return card('DATA_INSUFFICIENT','HIGH',observation,'لا توجد حدود معتمدة كافية لتحويل هذه القراءة إلى قرار.','تحقق من مصدر القراءة وحدود التشغيل المعتمدة قبل اتخاذ قرار.',confidence(observation));
  }
  if((cmin!==null && value<cmin) || (cmax!==null && value>cmax)){
    return card('CRITICAL','URGENT',observation,'القراءة خارج الحد الحرج المصرح به.','اتبع الإجراء التشغيلي/الطوارئ المعتمد فورًا. التطبيق لا يصدر أوامر تحكم تلقائية.',confidence(observation));
  }
  if((min!==null && value<min) || (max!==null && value>max)){
    return card('WATCH','MEDIUM',observation,'القراءة خارج نطاق التشغيل/المراقبة المعتمد.','تحقق من القياس ومصدره، وقارن الاتجاه والظروف التشغيلية، ثم نفّذ الإجراء المعتمد إذا لزم.',confidence(observation));
  }
  return card('NORMAL','LOW',observation,'القراءة داخل الحدود المعتمدة المتاحة.','استمر في المراقبة وفق الخطة والإجراء المعتمدين.',confidence(observation));
}

function confidence(o){
  let c=CONFIDENCE[o?.validation_state]??0.45;
  if(o?.evidence_id)c=Math.min(1,c+0.1);
  return Math.round(c*100)/100;
}
function card(status,priority,o,interpretation,next_step,conf){
  return {decision_id:`dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`,entity_id:o?.entity_id||null,observation_id:o?.observation_id||null,status,priority,property_name:o?.property_name||null,value:o?.value??null,unit:o?.unit||null,interpretation,recommended_next_step:next_step,confidence:conf,evidence_id:o?.evidence_id||null,engine_version:'DSE-1.0',created_at:new Date().toISOString()};
}

export function evaluateObservations(observations=[]){
  return observations.map(evaluateObservation).sort((a,b)=>({URGENT:0,HIGH:1,MEDIUM:2,LOW:3}[a.priority]??9)-({URGENT:0,HIGH:1,MEDIUM:2,LOW:3}[b.priority]??9));
}
export function summarizeDecisions(cards=[]){
  const order={CRITICAL:0,INVESTIGATE:1,WATCH:2,DATA_INSUFFICIENT:3,NORMAL:4};
  const top=[...cards].sort((a,b)=>(order[a.status]??9)-(order[b.status]??9))[0];
  return {count:cards.length,critical:cards.filter(x=>x.status==='CRITICAL').length,investigate:cards.filter(x=>x.status==='INVESTIGATE').length,watch:cards.filter(x=>x.status==='WATCH').length,insufficient:cards.filter(x=>x.status==='DATA_INSUFFICIENT').length,normal:cards.filter(x=>x.status==='NORMAL').length,highest:top?.status||'DATA_INSUFFICIENT'};
}
export const DECISION_STATES=STATES;
