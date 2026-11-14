// 资料组查看入口：按来源系列汇总原始标识、规范维度、有效属性与定义依据。
function viewOf(interpretation,rawMeta){
  const common={
    interpretationStatus:interpretation.interpretationStatus,
    confirmed:interpretation.confirmed===true,
    confirmedAt:interpretation.confirmedAt??null,
    interpretedAt:interpretation.interpretedAt,
    definitionBasis:interpretation.basis,
    rawMaterial:rawMeta?{
      sha256:rawMeta.sha256,
      sourcePath:rawMeta.sourcePath,
      contentType:rawMeta.contentType,
      fetchedAt:rawMeta.fetchedAt,
      file:rawMeta.file
    }:null
  };

  if(interpretation.interpretationStatus==='structure-pending'){
    return {
      ...common,
      pendingReason:interpretation.pendingReason,
      pendingAnomalyId:interpretation.pendingAnomalyId
    };
  }

  return {
    ...common,
    representation:interpretation.representation,
    rawKey:interpretation.rawKey,
    rawSeries:interpretation.rawSeries,
    canonicalDimensions:interpretation.canonicalDimensions,
    seriesAttributes:interpretation.seriesAttributes,
    observations:interpretation.observations.map(obs=>({
      time:obs.time,
      valueState:obs.valueState,
      status:obs.status,
      confidentiality:obs.confidentiality,
      effectiveAttributes:obs.effectiveAttributes,
      attributes:obs.attributes,
      raw:obs.raw
    }))
  };
}

export function listSeries(store){
  const state=store.state();
  return Object.values(state.series).map(entry=>({
    seriesId:entry.seriesId,
    versions:Object.fromEntries(Object.entries(entry.interpretations).map(([version,interpretation])=>[
      version,
      viewOf(interpretation,state.raw[interpretation.rawSha256]??null)
    ]))
  }));
}

export function getSeries(store,seriesId){
  const state=store.state();
  const entry=state.series[seriesId];
  if(!entry)return null;
  return {
    seriesId:entry.seriesId,
    versions:Object.fromEntries(Object.entries(entry.interpretations).map(([version,interpretation])=>[
      version,
      viewOf(interpretation,state.raw[interpretation.rawSha256]??null)
    ]))
  };
}

export function listAnomalies(store,{includeResolved=false}={}){
  return store.state().anomalies.filter(anomaly=>includeResolved||!anomaly.resolved);
}

export function listBundles(store){
  return store.listBundles().map(bundle=>({
    flow:bundle.flow,
    structureVersion:bundle.structureVersion,
    structureReference:bundle.structureReference,
    pinnedFromLatest:bundle.pinnedFromLatest,
    status:bundle.status,
    missing:bundle.missing,
    sha256:bundle.sha256,
    fetchedAt:bundle.fetchedAt,
    resources:bundle.resources
  }));
}

export function listHarvests(store){
  return store.state().harvests;
}
