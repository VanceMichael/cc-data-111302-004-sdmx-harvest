import {fetchStructureBundle} from './structure.mjs';
import {parseDataset} from './dataset.mjs';
import {interpretDataset} from './interpret.mjs';

// 一次领取：结构钉版 -> 原文落盘 -> 按钉版结构解释 -> 异常隔离。
// 结构包不完整（如迟到码表 404）时不假装缺报，序列进入 structure-pending 并挂出异常。
export async function harvest(store,sourceUrl,{timeout=5000}={}){
  const bundle=await fetchStructureBundle(sourceUrl,{timeout});
  store.putBundle(bundle);

  const response=await fetch(sourceUrl.replace(/\/+$/,'')+'/data',{signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error(`数据原文读取失败: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const contentType=response.headers.get('content-type')??'application/xml';
  const rawMeta=await store.saveRaw(bytes,{sourcePath:'/data',contentType,fetchedAt:new Date().toISOString()});
  const parsed=parseDataset(bytes.toString('utf8'));

  const summary={
    sourceUrl,
    rawSha256:rawMeta.sha256,
    representation:parsed.representation,
    structureVersion:bundle.structureVersion,
    pinnedFromLatest:bundle.pinnedFromLatest,
    bundleStatus:bundle.status,
    seriesTotal:parsed.series.length,
    seriesInterpreted:0,
    seriesPending:0,
    anomaliesOpened:0,
    anomaliesDuplicate:0
  };

  if(bundle.status!=='complete'){
    const anomaly=store.addAnomaly({
      type:'structure-pending',
      flow:bundle.flow,
      structureVersion:bundle.structureVersion,
      rawSha256:rawMeta.sha256,
      missing:bundle.missing,
      message:`结构版本 ${bundle.structureVersion} 缺少资料：${bundle.missing.map(item=>item.path).join(', ')}，相关序列暂不解释`
    });
    summary.anomaliesOpened+=1;
    for(const rawSeries of parsed.series){
      const provisionalId=provisionalSeriesId(rawSeries,bundle.structureVersion);
      store.markSeriesPending(provisionalId,bundle.flow,bundle.structureVersion,{
        rawSha256:rawMeta.sha256,
        reason:anomaly.message,
        anomalyId:anomaly.id
      });
      summary.seriesPending+=1;
    }
    await store.persist();
    return store.recordHarvest(summary);
  }

  const {seriesRecords,anomalies}=interpretDataset(parsed,bundle);
  const openAnomalies=store.state().anomalies.filter(item=>!item.resolved);
  summary.anomaliesDuplicate=0;
  for(const anomaly of anomalies){
    const alreadyOpen=openAnomalies.some(existing=>existing.type===anomaly.type
      &&existing.rawSha256===rawMeta.sha256
      &&existing.code===anomaly.code
      &&existing.dimension===anomaly.dimension);
    if(alreadyOpen){summary.anomaliesDuplicate+=1;continue;}
    store.addAnomaly({...anomaly,rawSha256:rawMeta.sha256});
    summary.anomaliesOpened+=1;
  }
  for(const record of seriesRecords){
    store.putSeriesInterpretation(record,{rawSha256:rawMeta.sha256,interpretationStatus:'interpreted'});
  }
  summary.seriesInterpreted=seriesRecords.length;
  await store.persist();
  return store.recordHarvest(summary);
}

// 修订结构到齐后，只重新解释受影响的原文；已确认的解释与其他结构版本的发布不动。
export async function reInterpret(store,sourceUrl,{timeout=5000}={}){
  const state=store.state();
  const incomplete=Object.values(state.bundles).filter(bundle=>bundle.status!=='complete');
  const refreshed=[];
  for(const oldBundle of incomplete){
    const bundle=await fetchStructureBundle(sourceUrl,{timeout});
    if(bundle.structureVersion!==oldBundle.structureVersion)continue;
    if(bundle.status!=='complete')continue;
    store.putBundle(bundle);
    const resolved=store.resolveAnomalies(
      anomaly=>anomaly.type==='structure-pending'&&anomaly.structureVersion===bundle.structureVersion,
      {reason:'迟到的结构资料已到齐，重新解释完成'}
    );
    refreshed.push({flow:bundle.flow,structureVersion:bundle.structureVersion,resolvedAnomalies:resolved.length});
  }

  // 按“原文 + 流程 + 结构版本”分组：每组只解析一次原文、解释一次，
  // 再把该组下所有挂起占位条目统一替换为正式序列（或继续保留为异常）。
  const groups=new Map();
  for(const [seriesId,entry] of Object.entries(state.series)){
    for(const [version,interpretation] of Object.entries(entry.interpretations)){
      if(interpretation.interpretationStatus!=='structure-pending')continue;
      const key=`${interpretation.rawSha256}|${interpretation.basis.flow}|${version}`;
      if(!groups.has(key)){
        groups.set(key,{
          rawSha256:interpretation.rawSha256,
          flow:interpretation.basis.flow,
          version:Number(version),
          provisionalIds:[]
        });
      }
      groups.get(key).provisionalIds.push(seriesId);
    }
  }

  const results=[];
  for(const group of groups.values()){
    const bundle=store.findCompleteBundle(group.flow,group.version);
    if(!bundle)continue;
    const bytes=await store.readRawBytes(group.rawSha256);
    const parsed=parseDataset(bytes.toString('utf8'));
    const {seriesRecords,anomalies}=interpretDataset(parsed,bundle);

    for(const anomaly of anomalies){
      // 若原文仍引用未知码，异常保持打开；这不是缺报。
      const alreadyOpen=state.anomalies.some(existing=>!existing.resolved
        &&existing.type==='unknown-code'
        &&existing.rawSha256===group.rawSha256
        &&existing.code===anomaly.code
        &&existing.dimension===anomaly.dimension);
      if(!alreadyOpen)store.addAnomaly({...anomaly,rawSha256:group.rawSha256});
    }

    const producedIds=[];
    for(const record of seriesRecords){
      const outcome=store.putSeriesInterpretation(record,{
        rawSha256:group.rawSha256,
        interpretationStatus:'interpreted'
      });
      producedIds.push(record.seriesId);
      results.push({seriesId:record.seriesId,structureVersion:group.version,outcome:outcome.status});
    }

    // 该组的挂起占位条目整体移除；正式标识若与占位同名则已被上面的写入接管。
    for(const provisionalId of group.provisionalIds){
      if(producedIds.includes(provisionalId))continue;
      delete state.series[provisionalId]?.interpretations[String(group.version)];
      if(state.series[provisionalId]&&Object.keys(state.series[provisionalId].interpretations).length===0){
        delete state.series[provisionalId];
      }
    }
  }
  await store.persist();
  return {refreshed,reinterpreted:results};
}

function provisionalSeriesId(rawSeries,version){
  if(rawSeries.rawKey!==null)return `pending:v${version}:key:${rawSeries.rawKey}`;
  const ids=rawSeries.keyComponents.map(component=>`${component.id}=${component.value}`).join('|');
  return `pending:v${version}:generic#${rawSeries.index}:${ids}`;
}
