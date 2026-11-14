import http from 'node:http';
import {readFile} from 'node:fs/promises';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}

function structurePayload(version){
  return {
    id:'industry',
    version,
    dimensions:version===1?['REGION','MEASURE']:['MEASURE','REGION'],
    attributes:{
      UNIT:{level:'dataset'},
      CONFID:{level:'series'},
      STATUS:{level:'observation'}
    },
    codes:`/codes/${version}`,
    concepts:`/concepts/${version}`
  };
}

function conceptsPayload(version){
  return {
    id:'industry',
    version,
    concepts:{
      REGION:{name:'地区',definition:'统计发布覆盖的行政地区，取值来自地区码表',representation:'code-list',list:`/codes/${version}#REGION`},
      MEASURE:{name:'计量维度',definition:'观测所计量的业务指标',representation:'code-list',list:`/codes/${version}#MEASURE`},
      UNIT:{name:'计量单位',definition:'数据集级属性，标明本数据集观测数值的计量单位'},
      CONFID:{name:'保密标记',definition:'序列级属性；1 表示该序列受保密限制，取值限制见观测状态定义'},
      STATUS:{
        name:'观测状态',
        definition:'观测级属性，描述发布方对本期观测的真实表达；缺省或 A 表示正常数值',
        representation:'code-list',
        codes:{
          A:{name:'正常值',definition:'随附数值为发布方确认的有效观测'},
          C:{name:'保密，不可披露',definition:'发布方持有观测但依法不予披露，本消息不携带数值',nonDisclosable:true,noValue:true},
          M:{name:'缺报',definition:'发布方本期未提供观测，不能按零值处理',missing:true,noValue:true}
        }
      }
    }
  };
}

function codesPayload(version){
  return {
    version,
    REGION:version===1?{A:'甲区'}:{A:'甲区',B:'新区'},
    MEASURE:{COUNT:'计数'}
  };
}

function dataPayload(state){
  const v=state.structureVersion;
  if(state.representation==='generic'){
    if(v===1){
      return `<DataSet structure="1" UNIT="person"><Series><Key><Value id="REGION" value="A"/><Value id="MEASURE" value="COUNT"/></Key><Obs time="2026-10" value="12" STATUS="A"/><Obs time="2026-11" STATUS="C"/></Series></DataSet>`;
    }
    return `<DataSet structure="2" UNIT="person"><Series><Key><Value id="MEASURE" value="COUNT"/><Value id="REGION" value="B"/></Key><Obs time="2026-10" value="12" STATUS="A"/><Obs time="2026-11" STATUS="C"/></Series><Series CONFID="1"><Key><Value id="MEASURE" value="COUNT"/><Value id="REGION" value="Z"/></Key><Obs time="2026-10" value="7" STATUS="A"/></Series></DataSet>`;
  }
  if(v===1){
    return `<DataSet structure="1" UNIT="person"><Series key="A.COUNT"><Obs time="2026-10" value="12" STATUS="A"/><Obs time="2026-11" STATUS="C"/></Series></DataSet>`;
  }
  return `<DataSet structure="2" UNIT="person"><Series key="COUNT.B"><Obs time="2026-10" value="12" STATUS="A"/><Obs time="2026-11" STATUS="C"/></Series><Series key="COUNT.Z" CONFID="1"><Obs time="2026-10" value="7" STATUS="A"/></Series></DataSet>`;
}

export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));

  const pages={};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){Object.assign(state,body); return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}

      if(url.pathname==='/flow') return json(response,{id:'industry',structure:'latest'});
      if(url.pathname.startsWith('/structure/')){
        const version=url.pathname.endsWith('latest')?state.structureVersion:Number(url.pathname.split('/').pop());
        return json(response,structurePayload(version));
      }
      if(url.pathname.startsWith('/concepts/')){
        const version=url.pathname.endsWith('latest')?state.structureVersion:Number(url.pathname.split('/').pop());
        return json(response,conceptsPayload(version));
      }
      if(url.pathname.startsWith('/codes/')){
        const version=Number(url.pathname.split('/').pop());
        if(version===2&&state.lateCodes)return json(response,{error:'码表未就绪'},404);
        return json(response,codesPayload(version));
      }
      if(url.pathname==='/data'){
        response.setHeader('Content-Type','application/xml');
        return response.end(dataPayload(state));
      }

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
