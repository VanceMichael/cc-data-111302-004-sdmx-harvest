// 用一份确定版本的结构包解释已解析的数据集。
// 关键纪律：
// 1. 紧凑表示的位置键只按结构包声明的维度顺序还原，绝不按旧顺序猜测；
// 2. 引用未知码的整条序列转异常，不影响其他序列，异常不等于缺报；
// 3. 不可披露/缺报观测没有数值就是没有数值，不得写成空串或 0 后继续当数值用。

export class InterpretError extends Error {}

function numericOrRaw(rawValue){
  if(rawValue===null||rawValue===undefined)return {numeric:null,text:null};
  const trimmed=String(rawValue).trim();
  if(trimmed!==''&&!Number.isNaN(Number(trimmed))){
    return {numeric:Number(trimmed),text:rawValue};
  }
  return {numeric:null,text:rawValue};
}

export function interpretDataset(parsed,bundle){
  if(bundle.status!=='complete'){
    throw new InterpretError(`结构包 ${bundle.structureVersion} 不完整，无法解释：${bundle.missing.map(item=>item.path).join(', ')}`);
  }
  const structure=bundle.structure;
  const dimensions=structure.dimensions;
  const attributeDefs=structure.attributes??{};
  const codes=bundle.codes??{};
  const conceptDefs=bundle.concepts?.concepts??{};
  const statusConcept=conceptDefs.STATUS;
  const statusCodes=statusConcept?.codes??{};

  const datasetAttributes=[];
  for(const [name,value] of Object.entries(parsed.datasetAttributes)){
    if(name==='structure')continue;
    datasetAttributes.push({name,value,level:'dataset',definition:conceptDefs[name]?.definition??null});
  }

  const seriesRecords=[];
  const anomalies=[];
  const basis={
    flow:bundle.flow,
    structureVersion:bundle.structureVersion,
    structureReference:bundle.structureReference,
    pinnedFromLatest:bundle.pinnedFromLatest,
    bundleSha256:bundle.sha256,
    resourceHashes:Object.fromEntries(
      Object.entries(bundle.resources).map(([name,res])=>[name,{path:res.path,sha256:res.sha256}])
    )
  };

  for(const rawSeries of parsed.series){
    let canonicalDimensions;
    try{
      canonicalDimensions=resolveDimensions(rawSeries,dimensions,codes,conceptDefs);
    }catch(error){
      if(error instanceof UnknownCodeError){
        anomalies.push({
          type:'unknown-code',
          seriesIndex:rawSeries.index,
          representation:rawSeries.representation,
          rawKey:rawSeries.rawKey,
          rawSeries:rawSeries.raw,
          code:error.code,
          dimension:error.dimension,
          message:error.message,
          basis
        });
        continue;
      }
      throw error;
    }

    const seriesAttributes=[];
    for(const [name,value] of Object.entries(rawSeries.attributes)){
      seriesAttributes.push({
        name,
        value,
        level:attributeDefs[name]?.level??'series',
        definition:conceptDefs[name]?.definition??null
      });
    }

    const seriesId=canonicalDimensions.map(dim=>`${dim.id}=${dim.code}`).join('|');
    const observations=rawSeries.observations.map(rawObs=>{
      const obsAttributes=[];
      for(const [name,value] of Object.entries(rawObs.attributes)){
        obsAttributes.push({
          name,
          value,
          level:attributeDefs[name]?.level??'observation',
          definition:conceptDefs[name]?.definition??null
        });
      }
      // 有效属性 = 数据集级继承 + 序列级继承 + 观测级覆盖，后级同名覆盖前级。
      const effectiveAttributes={};
      for(const attr of [...datasetAttributes,...seriesAttributes,...obsAttributes]){
        effectiveAttributes[attr.name]=attr.value;
      }

      const statusValue=rawObs.attributes.STATUS??null;
      const statusDef=statusValue===null?null:(statusCodes[statusValue]??null);
      const noValueByStatus=statusDef?.noValue===true;
      const hasValue=rawObs.hasValue;

      let valueState;
      const {numeric,text}=numericOrRaw(rawObs.rawValue);
      if(hasValue){
        if(noValueByStatus){
          // 状态语义声称无数值却带了值：忠实保留原文，同时标记语义冲突，不静默吞掉。
          valueState={kind:'conflicting-value',rawValue:text,numeric,
            message:`观测状态 ${statusValue} 的定义为无数值，但原文携带了 value="${text}"`};
        }else{
          valueState={kind:'numeric',rawValue:text,numeric};
        }
      }else{
        valueState={
          kind:'no-value',
          rawValue:null,
          numeric:null,
          reason:statusDef?(statusDef.nonDisclosable?'non-disclosable':statusDef.missing?'missing':'no-value-by-status')
            :'no-value-attribute',
          statusDefinition:statusDef?.definition??null
        };
      }

      return {
        time:rawObs.time,
        valueState,
        status:statusValue===null?null:{
          code:statusValue,
          name:statusDef?.name??null,
          definition:statusDef?.definition??null,
          nonDisclosable:statusDef?.nonDisclosable===true,
          missing:statusDef?.missing===true,
          conceptDefined:statusDef!==null
        },
        confidentiality:effectiveAttributes.CONFID??null,
        effectiveAttributes,
        attributes:[...datasetAttributes,...seriesAttributes,...obsAttributes],
        raw:rawObs.raw
      };
    });

    seriesRecords.push({
      seriesId,
      representation:rawSeries.representation,
      rawKey:rawSeries.rawKey,
      rawSeries:rawSeries.raw,
      canonicalDimensions,
      seriesAttributes,
      observations,
      basis
    });
  }

  return {seriesRecords,anomalies,basis};
}

class UnknownCodeError extends Error {
  constructor(dimension,code){
    super(`维度 ${dimension} 引用了当前码表中不存在的码：${code}`);
    this.dimension=dimension;
    this.code=code;
  }
}

function resolveDimensions(rawSeries,dimensions,codes,conceptDefs){
  if(rawSeries.representation==='compact'){
    if(rawSeries.keyComponents.length!==dimensions.length){
      throw new InterpretError(
        `序列 ${rawSeries.index+1} 的紧凑键有 ${rawSeries.keyComponents.length} 段，结构版本要求 ${dimensions.length} 个维度`
      );
    }
    return dimensions.map((id,position)=>buildDimension(id,rawSeries.keyComponents[position].value,codes,conceptDefs));
  }
  const byId=new Map(rawSeries.keyComponents.map(component=>[component.id,component.value]));
  const missing=dimensions.filter(id=>!byId.has(id));
  if(missing.length>0)throw new InterpretError(`通用序列 ${rawSeries.index+1} 缺少维度：${missing.join(', ')}`);
  return dimensions.map(id=>buildDimension(id,byId.get(id),codes,conceptDefs));
}

function buildDimension(id,code,codes,conceptDefs){
  const list=codes[id]??{};
  if(!Object.hasOwn(list,code))throw new UnknownCodeError(id,code);
  return {
    id,
    code,
    name:list[code],
    definition:conceptDefs[id]?.definition??null,
    representation:conceptDefs[id]?.representation??null
  };
}
