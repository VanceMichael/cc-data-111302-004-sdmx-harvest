import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const STATE_FILE='store.json';

export class StoreError extends Error {}

export async function createStore(directory,sourceUrl){
  await mkdir(directory,{recursive:true});
  await mkdir(join(directory,'raw'),{recursive:true});
  const statePath=join(directory,STATE_FILE);
  let state;
  try{
    state=JSON.parse(await readFile(statePath,'utf8'));
    if(sourceUrl&&state.sourceUrl!==sourceUrl){
      throw new StoreError(`存储目录已绑定来源 ${state.sourceUrl}，与 ${sourceUrl} 不一致`);
    }
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    state={
      schemaVersion:1,
      sourceUrl:sourceUrl??null,
      createdAt:new Date().toISOString(),
      raw:{},
      bundles:{},
      series:{},
      anomalies:[],
      harvests:[]
    };
  }
  if(sourceUrl)state.sourceUrl=sourceUrl;

  async function persist(){
    const tmp=join(directory,`.${STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp,JSON.stringify(state,null,2));
    await rename(tmp,statePath);
  }

  async function saveRaw(bytes,{sourcePath,contentType,fetchedAt}){
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(!state.raw[sha256]){
      const fileName=`${sha256}.xml`;
      await writeFile(join(directory,'raw',fileName),bytes);
      state.raw[sha256]={
        sha256,
        sourcePath,
        contentType,
        fetchedAt,
        byteLength:bytes.length,
        file:`raw/${fileName}`
      };
      await persist();
    }
    return state.raw[sha256];
  }

  function bundleKey(bundle){
    return `${bundle.flow}:v${bundle.structureVersion}`;
  }

  function putBundle(bundle){
    const key=bundleKey(bundle);
    const existing=state.bundles[key];
    if(existing?.status==='complete'){
      // 完整结构包是历史解释的定义依据，永不覆盖。
      return {bundle:existing,changed:false,reason:'complete-bundle-is-immutable'};
    }
    state.bundles[key]=bundle;
    return {bundle,changed:true};
  }

  function getBundle(flow,version){
    return state.bundles[`${flow}:v${version}`]??null;
  }

  function listBundles(){
    return Object.values(state.bundles);
  }

  function findCompleteBundle(flow,version){
    const bundle=getBundle(flow,version);
    return bundle&&bundle.status==='complete'?bundle:null;
  }

  function addAnomaly(anomaly){
    const id=`an-${state.anomalies.length+1}-${createHash('sha256').update(JSON.stringify(anomaly)).digest('hex').slice(0,10)}`;
    const record={id,openedAt:new Date().toISOString(),resolved:false,resolution:null,...anomaly};
    state.anomalies.push(record);
    return record;
  }

  function resolveAnomalies(predicate,resolution){
    const resolved=[];
    for(const anomaly of state.anomalies){
      if(!anomaly.resolved&&predicate(anomaly)){
        anomaly.resolved=true;
        anomaly.resolution={at:new Date().toISOString(),...resolution};
        resolved.push(anomaly);
      }
    }
    return resolved;
  }

  // 同一原文 + 同一结构版本的解释可替换（重解释）；不同结构版本各自独立保存，
  // 已确认的解释不允许覆盖，避免抹掉已确认的别版统计发布。
  function putSeriesInterpretation(record,{rawSha256,interpretationStatus}){
    const version=record.basis.structureVersion;
    const entry=state.series[record.seriesId]??={seriesId:record.seriesId,interpretations:{}};
    const existing=entry.interpretations[version];
    if(existing?.confirmed){
      return {status:'rejected-confirmed',existing};
    }
    entry.interpretations[version]={
      ...record,
      rawSha256,
      interpretationStatus,
      interpretedAt:new Date().toISOString(),
      confirmed:false
    };
    return {status:existing?'replaced':'created',entry:entry.interpretations[version]};
  }

  function markSeriesPending(seriesId,flow,version,{rawSha256,reason,anomalyId}){
    const entry=state.series[seriesId]??={seriesId,interpretations:{}};
    const existing=entry.interpretations[version];
    if(existing?.confirmed)return {status:'rejected-confirmed',existing};
    entry.interpretations[version]={
      seriesId,
      interpretationStatus:'structure-pending',
      rawSha256,
      pendingReason:reason,
      pendingAnomalyId:anomalyId??null,
      basis:{flow,structureVersion:version},
      interpretedAt:new Date().toISOString(),
      confirmed:false
    };
    return {status:existing?'replaced':'created',entry:entry.interpretations[version]};
  }

  function confirmInterpretation(seriesId,version){
    const entry=state.series[seriesId];
    const interpretation=entry?.interpretations[version];
    if(!interpretation)throw new StoreError(`找不到系列 ${seriesId} 的结构版本 ${version} 解释`);
    if(interpretation.interpretationStatus!=='interpreted'){
      throw new StoreError('只有成功解释的记录可以确认');
    }
    interpretation.confirmed=true;
    interpretation.confirmedAt=new Date().toISOString();
    return interpretation;
  }

  function recordHarvest(harvest){
    const id=`hv-${state.harvests.length+1}`;
    const record={id,at:new Date().toISOString(),...harvest};
    state.harvests.push(record);
    return record;
  }

  function getRaw(sha256){
    return state.raw[sha256]??null;
  }

  async function readRawBytes(sha256){
    const meta=state.raw[sha256];
    if(!meta)throw new StoreError(`原文 ${sha256} 不存在`);
    return readFile(join(directory,meta.file));
  }

  return {
    directory,
    persist,
    saveRaw,
    putBundle,
    getBundle,
    listBundles,
    findCompleteBundle,
    addAnomaly,
    resolveAnomalies,
    putSeriesInterpretation,
    markSeriesPending,
    confirmInterpretation,
    recordHarvest,
    getRaw,
    readRawBytes,
    state:()=>state
  };
}
