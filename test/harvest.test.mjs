import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDataset} from '../src/harvest/dataset.mjs';
import {interpretDataset} from '../src/harvest/interpret.mjs';

const concepts={
  concepts:{
    REGION:{name:'地区',definition:'地区定义',representation:'code-list'},
    MEASURE:{name:'计量',definition:'计量定义',representation:'code-list'},
    UNIT:{name:'单位',definition:'单位定义'},
    CONFID:{name:'保密',definition:'保密定义'},
    STATUS:{
      name:'观测状态',
      definition:'状态定义',
      codes:{
        A:{name:'正常',definition:'正常观测'},
        C:{name:'保密',definition:'不可披露',nonDisclosable:true,noValue:true},
        M:{name:'缺报',definition:'缺报',missing:true,noValue:true}
      }
    }
  }
};

function bundle(overrides={}){
  return {
    flow:'industry',
    structureReference:'latest',
    pinnedFromLatest:true,
    structureVersion:1,
    sha256:'bundle-hash',
    status:'complete',
    structure:{
      version:1,
      dimensions:['REGION','MEASURE'],
      attributes:{UNIT:{level:'dataset'},CONFID:{level:'series'},STATUS:{level:'observation'}}
    },
    codes:{REGION:{A:'甲区'},MEASURE:{COUNT:'计数'}},
    concepts,
    resources:{
      flow:{path:'/flow',sha256:'h1'},
      structure:{path:'/structure/1',sha256:'h2'},
      codes:{path:'/codes/1',sha256:'h3'},
      concepts:{path:'/concepts/1',sha256:'h4'}
    },
    ...overrides
  };
}

test('紧凑表示按结构声明的维度顺序解释，无数值观测不被当成0或空串',()=>{
  const parsed=parseDataset(
    '<DataSet structure="1" UNIT="person"><Series key="A.COUNT">'
    +'<Obs time="2026-10" value="12" STATUS="A"/>'
    +'<Obs time="2026-11" STATUS="C"/>'
    +'</Series></DataSet>'
  );
  assert.equal(parsed.representation,'compact');
  const {seriesRecords,anomalies}=interpretDataset(parsed,bundle());
  assert.equal(anomalies.length,0);
  const series=seriesRecords[0];
  assert.deepEqual(series.canonicalDimensions.map(d=>[d.id,d.code,d.name]),
    [['REGION','A','甲区'],['MEASURE','COUNT','计数']]);

  const [normal,confidential]=series.observations;
  assert.equal(normal.valueState.kind,'numeric');
  assert.equal(normal.valueState.numeric,12);
  assert.equal(normal.valueState.rawValue,'12');
  assert.equal(confidential.valueState.kind,'no-value');
  assert.equal(confidential.valueState.numeric,null);
  assert.equal(confidential.valueState.rawValue,null);
  assert.equal(confidential.valueState.reason,'non-disclosable');
  assert.equal(confidential.status.nonDisclosable,true);
  // 有效属性含数据集级继承下来的 UNIT。
  assert.equal(confidential.effectiveAttributes.UNIT,'person');
  assert.equal(confidential.effectiveAttributes.STATUS,'C');
});

test('通用表示按 Key 中的概念标识解释，与位置无关；属性三级继承',()=>{
  const xml='<DataSet structure="2" UNIT="person"><Series CONFID="1">'
    +'<Key><Value id="MEASURE" value="COUNT"/><Value id="REGION" value="A"/></Key>'
    +'<Obs time="2026-10" value="3" STATUS="A"/>'
    +'</Series></DataSet>';
  const parsed=parseDataset(xml);
  assert.equal(parsed.representation,'generic');
  const v2=bundle({structureVersion:2,structure:{version:2,dimensions:['MEASURE','REGION'],
    attributes:{UNIT:{level:'dataset'},CONFID:{level:'series'},STATUS:{level:'observation'}}}});
  const {seriesRecords}=interpretDataset(parsed,v2);
  const series=seriesRecords[0];
  assert.deepEqual(series.canonicalDimensions.map(d=>d.id),['MEASURE','REGION']);
  assert.equal(series.seriesId,'MEASURE=COUNT|REGION=A');
  const obs=series.observations[0];
  assert.equal(obs.confidentiality,'1');
  assert.deepEqual(obs.effectiveAttributes,{UNIT:'person',CONFID:'1',STATUS:'A'});
});

test('引用未知码的序列转异常，其他序列照常解释，异常不是缺报',()=>{
  const xml='<DataSet structure="1" UNIT="person">'
    +'<Series key="A.COUNT"><Obs time="2026-10" value="1" STATUS="A"/></Series>'
    +'<Series key="Z.COUNT"><Obs time="2026-10" value="2" STATUS="A"/></Series>'
    +'</DataSet>';
  const parsed=parseDataset(xml);
  const {seriesRecords,anomalies}=interpretDataset(parsed,bundle());
  assert.equal(seriesRecords.length,1);
  assert.equal(seriesRecords[0].seriesId,'REGION=A|MEASURE=COUNT');
  assert.equal(anomalies.length,1);
  assert.equal(anomalies[0].type,'unknown-code');
  assert.equal(anomalies[0].dimension,'REGION');
  assert.equal(anomalies[0].code,'Z');
});

test('缺报状态与不可披露状态都保留无数值语义，且彼此可区分',()=>{
  const xml='<DataSet structure="1" UNIT="person"><Series key="A.COUNT">'
    +'<Obs time="2026-10" STATUS="M"/><Obs time="2026-11" STATUS="C"/>'
    +'</Series></DataSet>';
  const parsed=parseDataset(xml);
  const {seriesRecords}=interpretDataset(parsed,bundle());
  const [missing,confidential]=seriesRecords[0].observations;
  assert.equal(missing.valueState.kind,'no-value');
  assert.equal(missing.valueState.reason,'missing');
  assert.equal(missing.status.missing,true);
  assert.equal(confidential.valueState.reason,'non-disclosable');
  assert.notDeepEqual(missing.valueState,confidential.valueState);
});

test('结构包不完整时拒绝解释，避免用不确定的码表解释键',()=>{
  const parsed=parseDataset(
    '<DataSet structure="2" UNIT="person"><Series key="COUNT.A"><Obs time="2026-10" value="1" STATUS="A"/></Series></DataSet>'
  );
  const incomplete=bundle({structureVersion:2,status:'incomplete',missing:[{path:'/codes/2',status:404}]});
  assert.throws(()=>interpretDataset(parsed,incomplete),/不完整/);
});

test('状态定义为无数值却携带数值时标记语义冲突而不静默吞掉',()=>{
  const parsed=parseDataset(
    '<DataSet structure="1" UNIT="person"><Series key="A.COUNT"><Obs time="2026-10" value="9" STATUS="C"/></Series></DataSet>'
  );
  const {seriesRecords}=interpretDataset(parsed,bundle());
  const obs=seriesRecords[0].observations[0];
  assert.equal(obs.valueState.kind,'conflicting-value');
  assert.equal(obs.valueState.numeric,9);
});
