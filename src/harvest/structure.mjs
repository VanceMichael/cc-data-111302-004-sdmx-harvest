import {createHash} from 'node:crypto';

export class StructureError extends Error {}

export function sha256(text){
  return createHash('sha256').update(text).digest('hex');
}

function baseOf(url){
  return url.replace(/\/+$/,'');
}

async function getText(base,path,{timeout=5000}={}){
  const endpoint=path.startsWith('http')?path:base+path;
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(timeout)});
  const text=await response.text();
  if(!response.ok){
    const error=new StructureError(`资料读取失败 ${path}: HTTP ${response.status}`);
    error.status=response.status;
    error.endpoint=endpoint;
    throw error;
  }
  return {endpoint,text};
}

async function getJson(base,path,options){
  const {endpoint,text}=await getText(base,path,options);
  try{
    return {endpoint,payload:JSON.parse(text),raw:text};
  }catch{
    throw new StructureError(`资料不是合法JSON: ${path}`);
  }
}

// 沿数据流定义取得结构引用；latest 只在这一刻解析，之后全部改用确定版本号。
// 返回的 bundle 自带每份资料的原文哈希，使一组观测可追溯到确定的结构内容。
export async function fetchStructureBundle(base,{timeout=5000}={}){
  const root=baseOf(base);
  const flowResult=await getJson(root,'/flow',{timeout});
  const flow=flowResult.payload;
  const ref=flow.structure;
  if(typeof ref!=='string'||ref.length===0)throw new StructureError('数据流缺少结构引用');

  let structurePath;
  let pinnedFromLatest=false;
  if(ref==='latest'){
    const latest=await getJson(root,'/structure/latest',{timeout});
    if(!Number.isInteger(latest.payload.version))throw new StructureError('latest 结构缺少确定版本号');
    structurePath=`/structure/${latest.payload.version}`;
    pinnedFromLatest=true;
  }else{
    structurePath=ref.startsWith('/')?ref:`/structure/${ref}`;
  }

  const structureResult=await getJson(root,structurePath,{timeout});
  const structure=structureResult.payload;
  const version=structure.version;
  if(!Number.isInteger(version))throw new StructureError('结构缺少确定版本号');

  const codesPath=structure.codes;
  const conceptsPath=structure.concepts;
  if(!codesPath||!conceptsPath)throw new StructureError(`结构版本 ${version} 缺少码表或概念引用`);

  const bundle={
    flow:flow.id,
    structureReference:ref,
    pinnedFromLatest,
    structureVersion:version,
    structurePath,
    fetchedAt:new Date().toISOString(),
    resources:{
      flow:{path:'/flow',raw:flowResult.raw,sha256:sha256(flowResult.raw)},
      structure:{path:structurePath,raw:structureResult.raw,sha256:sha256(structureResult.raw)}
    },
    structure,
    status:'incomplete',
    missing:[]
  };

  try{
    const codesResult=await getJson(root,codesPath,{timeout});
    bundle.resources.codes={path:codesPath,raw:codesResult.raw,sha256:sha256(codesResult.raw)};
    bundle.codes=codesResult.payload;
  }catch(error){
    if(error instanceof StructureError&&error.status===404){
      bundle.missing.push({path:codesPath,reason:error.message,status:404});
    }else{
      throw error;
    }
  }

  try{
    const conceptsResult=await getJson(root,conceptsPath,{timeout});
    bundle.resources.concepts={path:conceptsPath,raw:conceptsResult.raw,sha256:sha256(conceptsResult.raw)};
    bundle.concepts=conceptsResult.payload;
  }catch(error){
    if(error instanceof StructureError&&error.status===404){
      bundle.missing.push({path:conceptsPath,reason:error.message,status:404});
    }else{
      throw error;
    }
  }

  bundle.status=bundle.missing.length===0?'complete':'incomplete';
  bundle.sha256=sha256(JSON.stringify(bundle.resources));
  return bundle;
}
