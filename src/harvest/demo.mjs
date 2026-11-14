import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../source.mjs';
import {createStore} from './store.mjs';
import {harvest,reInterpret} from './harvest.mjs';
import {getSeries,listAnomalies,listBundles} from './query.mjs';

function heading(text){console.log(`\n=== ${text} ===`);}
function show(label,value){console.log(`--- ${label} ---`);console.log(JSON.stringify(value,null,2));}

async function postControl(source,patch){
  const response=await fetch(source.url+'/control',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(patch),
    signal:AbortSignal.timeout(4000)
  });
  if(!response.ok)throw new Error(`控制请求失败: ${response.status}`);
  return response.json();
}

const source=await createSource();
const directory=await mkdtemp(join(tmpdir(),'sdmx-harvest-demo-'));
try{
  console.log(`本地交换站: ${source.url}`);
  console.log(`入库目录: ${directory}`);
  const store=await createStore(directory,source.url);

  // 1) 第一版结构、紧凑表示：位置键按 v1 维度顺序 [REGION, MEASURE] 解释。
  heading('1. 领取第一版（紧凑表示，结构引用为 latest，钉到 v1）');
  show('领取结果',await harvest(store,source.url));

  // 2. 切到通用表示再领一次：同一份原文形态不同，解释结果应一致。
  heading('2. 切换为通用表示后再次领取');
  await postControl(source,{representation:'generic'});
  show('领取结果',await harvest(store,source.url));
  const v1View=getSeries(store,'REGION=A|MEASURE=COUNT').versions['1'];
  show('系列 REGION=A|MEASURE=COUNT 的观测（注意保密观测无数值，不是空串也不是0）',
    v1View.observations.map(obs=>({
      time:obs.time,
      valueState:obs.valueState,
      status:obs.status,
      effectiveAttributes:obs.effectiveAttributes
    })));

  // 3. 机构调整：结构升级到 v2，维度顺序变为 [MEASURE, REGION] 且新增地区；码表迟到。
  heading('3. 结构升级到 v2（维度顺序调整、新增地区），v2 码表暂缺');
  await postControl(source,{structureVersion:2,lateCodes:true,representation:'compact'});
  show('领取结果（结构包不完整，序列挂起而非当成缺报）',await harvest(store,source.url));
  show('打开的异常',listAnomalies(store));

  // 4. 迟到码表到齐：只重新解释受影响原文，v1 已确认发布不受影响。
  heading('4. 迟到码表到齐，重新解释受影响原文');
  await postControl(source,{lateCodes:false});
  show('重解释结果',await reInterpret(store,source.url));

  // 5. 通用表示再领 v2：含一个引用未知码 Z 的序列，其他系列照常入库。
  heading('5. 通用表示领取 v2（含未知码 Z 的序列，隔离为异常而非缺报）');
  await postControl(source,{representation:'generic'});
  show('领取结果',await harvest(store,source.url));
  show('当前打开的异常',listAnomalies(store));

  // 6. 资料组按来源系列查看：原始标识、规范维度、有效属性、定义依据。
  heading('6. 资料组系列视图：MEASURE=COUNT|REGION=B（v2 新地区，顺序已变）');
  const v2Series=getSeries(store,'MEASURE=COUNT|REGION=B');
  show('规范维度与原始标识',{
    rawKey:v2Series.versions['2'].rawKey,
    canonicalDimensions:v2Series.versions['2'].canonicalDimensions,
    definitionBasis:v2Series.versions['2'].definitionBasis
  });
  show('观测（保密无数值语义保留）',v2Series.versions['2'].observations.map(obs=>({
    time:obs.time,
    valueState:obs.valueState,
    status:obs.status?.code??null,
    confidentiality:obs.confidentiality,
    effectiveAttributes:obs.effectiveAttributes
  })));

  // 7. 别版保护：确认 v1 后，后续操作不能覆盖它。
  heading('7. 确认 v1 统计发布，验证别版不被覆盖');
  store.confirmInterpretation('REGION=A|MEASURE=COUNT',1);
  await store.persist();
  const confirmAttempt=()=>{
    const entry=store.state().series['REGION=A|MEASURE=COUNT'];
    const v1=entry.interpretations['1'];
    return {confirmed:v1.confirmed,confirmedAt:v1.confirmedAt,stillInterpreted:v1.interpretationStatus==='interpreted'};
  };
  show('v1 确认状态（重解释/重领均不可覆盖）',confirmAttempt());
  show('结构包清单（latest 已钉成确定版本，含原文哈希）',listBundles(store).map(bundle=>({
    flow:bundle.flow,
    structureVersion:bundle.structureVersion,
    pinnedFromLatest:bundle.pinnedFromLatest,
    status:bundle.status,
    sha256:bundle.sha256
  })));

  heading('演示结束');
  console.log(`入库目录保留在: ${directory}（可用 node src/harvest/cli.mjs series --store ${directory} 查看）`);
}finally{
  await source.close();
  if(process.env.DEMO_KEEP_DIR!=='1')await rm(directory,{recursive:true,force:true});
}
