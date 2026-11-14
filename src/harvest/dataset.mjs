import {parseXml,children} from './xml.mjs';

export class DataParseError extends Error {}

// 把两种表示解析成与表示无关的中间形态；不做任何码表解释或数值推断。
// 无数值（Obs 没有 value 属性）在这里就与 value="0" 明确区分。
export function parseDataset(xml){
  const root=parseXml(xml);
  if(root.name!=='DataSet')throw new DataParseError(`根元素应为 DataSet，实际为 ${root.name}`);

  const structureRef=root.attributes.structure;
  if(structureRef===undefined)throw new DataParseError('DataSet 缺少 structure 属性');

  const seriesNodes=children(root,'Series');
  if(seriesNodes.length===0)throw new DataParseError('DataSet 不包含任何 Series');

  const series=seriesNodes.map((seriesNode,index)=>{
    const keyAttr=seriesNode.attributes.key;
    let representation;
    let rawKey;
    let keyComponents;

    if(keyAttr!==undefined){
      representation='compact';
      rawKey=keyAttr;
      keyComponents=keyAttr.split('.').map(value=>({value,raw:value}));
    }else{
      representation='generic';
      rawKey=null;
      const keyNode=children(seriesNode,'Key')[0];
      if(!keyNode)throw new DataParseError(`第 ${index+1} 个 Series 缺少 Key`);
      keyComponents=children(keyNode,'Value').map(valueNode=>{
        const id=valueNode.attributes.id;
        const value=valueNode.attributes.value;
        if(id===undefined||value===undefined)throw new DataParseError('Key/Value 必须同时含 id 与 value');
        return {id,value,raw:value};
      });
      if(keyComponents.length===0)throw new DataParseError(`第 ${index+1} 个 Series 的 Key 为空`);
    }

    const seriesAttributes={...seriesNode.attributes};
    delete seriesAttributes.key;

    const observations=children(seriesNode,'Obs').map((obsNode,obsIndex)=>{
      const attributes={...obsNode.attributes};
      const time=attributes.time;
      delete attributes.time;
      const hasValue=Object.hasOwn(attributes,'value');
      const rawValue=hasValue?attributes.value:null;
      delete attributes.value;
      return {
        index:obsIndex,
        time,
        hasValue,
        rawValue,
        attributes,
        raw:outerXml(obsNode)
      };
    });
    if(observations.length===0)throw new DataParseError(`第 ${index+1} 个 Series 不包含任何 Obs`);

    return {
      index,
      representation,
      rawKey,
      keyComponents,
      attributes:seriesAttributes,
      observations,
      raw:outerXml(seriesNode)
    };
  });

  return {
    structureRef,
    representation:series.every(item=>item.representation==='compact')?'compact'
      :series.every(item=>item.representation==='generic')?'generic':'mixed',
    datasetAttributes:{...root.attributes},
    series,
    raw:xml
  };
}

function outerXml(node){
  const attrs=Object.entries(node.attributes).map(([name,value])=>` ${name}="${value}"`).join('');
  if(node.children.length===0)return `<${node.name}${attrs}/>`;
  const inner=node.children.map(child=>outerXml(child)).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}
