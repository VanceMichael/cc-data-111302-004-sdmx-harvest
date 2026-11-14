import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createStore} from '../src/harvest/store.mjs';
import {harvest,reInterpret} from '../src/harvest/harvest.mjs';
import {getSeries,listAnomalies,listBundles,listSeries} from '../src/harvest/query.mjs';

async function withHarness(callback){
  const source=await createSource();
  const directory=await mkdtemp(join(tmpdir(),'sdmx-e2e-'));
  try{
    const store=await createStore(directory,source.url);
    await callback({source,store,directory});
  }finally{
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
}

async function control(source,patch){
  const response=await fetch(source.url+'/control',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(patch),
    signal:AbortSignal.timeout(4000)
  });
  assert.equal(response.status,200);
}

test('latest 在领取时钉成确定版本，结构包带原文哈希可追溯',()=>withHarness(async({source,store})=>{
  const result=await harvest(store,source.url);
  assert.equal(result.structureVersion,1);
  assert.equal(result.pinnedFromLatest,true);
  const bundles=listBundles(store);
  assert.equal(bundles.length,1);
  assert.equal(bundles[0].status,'complete');
  assert.ok(bundles[0].sha256.length===64);
  assert.ok(bundles[0].resources.structure.sha256.length===64);
  const series=getSeries(store,'REGION=A|MEASURE=COUNT');
  assert.equal(series.versions['1'].definitionBasis.bundleSha256,bundles[0].sha256);
}));

test('紧凑与通用两种表示解释出一致的规范维度，原文各自留痕',()=>withHarness(async({source,store})=>{
  await harvest(store,source.url);
  await control(source,{representation:'generic'});
  const second=await harvest(store,source.url);
  assert.equal(second.representation,'generic');
  const series=getSeries(store,'REGION=A|MEASURE=COUNT').versions['1'];
  assert.deepEqual(series.canonicalDimensions.map(d=>d.code),['A','COUNT']);
  const [numeric,confidential]=series.observations;
  assert.equal(numeric.valueState.numeric,12);
  assert.equal(confidential.valueState.kind,'no-value');
  assert.equal(confidential.valueState.reason,'non-disclosable');
  // 两次领取的原文都按哈希落盘。
  const rawFiles=Object.keys(store.state().raw);
  assert.equal(rawFiles.length,2);
  const bytes=await readFile(join(store.directory,store.getRaw(rawFiles[1]).file));
  assert.match(bytes.toString(),/<Key>/);
}));

test('迟到码表：序列挂起并开异常，码表到齐后只重解释受影响原文',()=>withHarness(async({source,store})=>{
  await harvest(store,source.url); // v1 先入库
  await control(source,{structureVersion:2,lateCodes:true,representation:'compact'});
  const v2Harvest=await harvest(store,source.url);
  assert.equal(v2Harvest.bundleStatus,'incomplete');
  assert.equal(v2Harvest.seriesPending,2);
  const open=listAnomalies(store);
  assert.ok(open.some(a=>a.type==='structure-pending'&&a.structureVersion===2));

  // 挂起不是缺报：占位记录明确带 structure-pending 状态。
  const pending=listSeries(store).find(entry=>entry.seriesId.startsWith('pending:v2'));
  assert.ok(pending);
  assert.equal(pending.versions['2'].interpretationStatus,'structure-pending');

  await control(source,{lateCodes:false});
  const result=await reInterpret(store,source.url);
  assert.equal(result.refreshed[0].structureVersion,2);
  // 同一份原文只重新解释一次：B 成为正式系列，Z 因未知码隔离为异常。
  assert.equal(result.reinterpreted.length,1);
  assert.equal(result.reinterpreted[0].seriesId,'MEASURE=COUNT|REGION=B');
  const upgraded=getSeries(store,'MEASURE=COUNT|REGION=B');
  assert.ok(upgraded.versions['2']);
  assert.deepEqual(upgraded.versions['2'].canonicalDimensions.map(d=>[d.id,d.code]),
    [['MEASURE','COUNT'],['REGION','B']]);
  // 挂起占位条目已清理。
  assert.equal(listSeries(store).filter(entry=>entry.seriesId.startsWith('pending:')).length,0);
  // 迟到期间的未知码在码表到齐后如实转为 unknown-code 异常，而不是缺报。
  assert.ok(listAnomalies(store).some(a=>a.type==='unknown-code'&&a.code==='Z'));
  // v1 系列与结构包仍然完好。
  const v1=getSeries(store,'REGION=A|MEASURE=COUNT').versions['1'];
  assert.equal(v1.interpretationStatus,'interpreted');
  assert.equal(listBundles(store).filter(b=>b.status==='complete').length,2);
  // structure-pending 异常已解决。
  assert.equal(listAnomalies(store).filter(a=>a.type==='structure-pending').length,0);
}));

test('未知码序列隔离为异常，其他系列正常入库且不伪装成缺报',()=>withHarness(async({source,store})=>{
  await control(source,{structureVersion:2,representation:'generic'});
  const result=await harvest(store,source.url);
  assert.equal(result.seriesInterpreted,1);
  assert.equal(result.anomaliesOpened,1);
  const anomalies=listAnomalies(store);
  assert.equal(anomalies.length,1);
  assert.equal(anomalies[0].type,'unknown-code');
  assert.equal(anomalies[0].code,'Z');
  const known=getSeries(store,'MEASURE=COUNT|REGION=B');
  assert.ok(known.versions['2']);
}));

test('已确认的解释在重领和重解释时都不被覆盖',()=>withHarness(async({source,store})=>{
  await harvest(store,source.url);
  store.confirmInterpretation('REGION=A|MEASURE=COUNT',1);
  await store.persist();
  const confirmedAt=store.state().series['REGION=A|MEASURE=COUNT'].interpretations['1'].confirmedAt;

  // 同版本再领一次：已确认解释拒绝替换。
  const again=await harvest(store,source.url);
  assert.equal(again.seriesInterpreted,1);
  const kept=store.state().series['REGION=A|MEASURE=COUNT'].interpretations['1'];
  assert.equal(kept.confirmed,true);
  assert.equal(kept.confirmedAt,confirmedAt);

  // 升级到 v2 后，v1 与 v2 各自独立，互不覆盖。
  await control(source,{structureVersion:2,representation:'compact'});
  await harvest(store,source.url);
  const entry=store.state().series['REGION=A|MEASURE=COUNT'];
  assert.ok(entry.interpretations['1']);
  assert.equal(entry.interpretations['1'].confirmed,true);
  assert.ok(getSeries(store,'MEASURE=COUNT|REGION=B').versions['2']);
}));

test('存储目录绑定来源地址，混用来源被拒绝',()=>withHarness(async({source,store})=>{
  await harvest(store,source.url);
  await assert.rejects(createStore(store.directory,'http://127.0.0.1:9/other'),/不一致/);
}));
