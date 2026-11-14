import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fetchStructureBundle} from '../src/harvest/structure.mjs';

function fakeSource(routes){
  const server=http.createServer((request,response)=>{
    const route=routes[request.url];
    if(!route){response.writeHead(404);return response.end('{}');}
    response.writeHead(route.status??200,{'Content-Type':'application/json'});
    response.end(JSON.stringify(route.body));
  });
  return new Promise(resolve=>{
    server.listen(0,'127.0.0.1',()=>{
      const url=`http://127.0.0.1:${server.address().port}`;
      resolve({url,close:()=>new Promise(done=>server.close(done))});
    });
  });
}

const concepts={concepts:{REGION:{definition:'地区'},MEASURE:{definition:'计量'}}};

test('latest 在领取瞬间解析为确定版本，之后只引用该版本资料',async()=>{
  const requested=[];
  const server=http.createServer((request,response)=>{
    requested.push(request.url);
    if(request.url==='/flow')return response.end(JSON.stringify({id:'industry',structure:'latest'}));
    if(request.url==='/structure/latest'){
      // 模拟领取期间 latest 已指向 v2，但结构内容只按 v1 交付。
      return response.end(JSON.stringify({id:'industry',version:1,dimensions:['REGION','MEASURE'],
        attributes:{},codes:'/codes/1',concepts:'/concepts/1'}));
    }
    if(request.url==='/structure/1')return response.end(JSON.stringify({id:'industry',version:1,
      dimensions:['REGION','MEASURE'],attributes:{},codes:'/codes/1',concepts:'/concepts/1'}));
    if(request.url==='/codes/1')return response.end(JSON.stringify({version:1,REGION:{A:'甲区'}}));
    if(request.url==='/concepts/1')return response.end(JSON.stringify({id:'industry',version:1,...concepts}));
    if(request.url.startsWith('/structure/2')||request.url.startsWith('/codes/2')){
      response.writeHead(500);return response.end('{}');
    }
    response.writeHead(404);response.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const bundle=await fetchStructureBundle(url);
    assert.equal(bundle.structureVersion,1);
    assert.equal(bundle.pinnedFromLatest,true);
    assert.equal(bundle.status,'complete');
    // 钉版后绝不触碰 v2 资料。
    assert.ok(!requested.some(path=>path.includes('/2')));
    assert.deepEqual(requested,['/flow','/structure/latest','/structure/1','/codes/1','/concepts/1']);
    assert.ok(bundle.resources.codes.sha256.length===64);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('码表 404 时结构包标记不完整并记录缺失项，不抛出业务误判',async()=>{
  const origin=await fakeSource({
    '/flow':{body:{id:'industry',structure:'latest'}},
    '/structure/latest':{body:{id:'industry',version:2,dimensions:['MEASURE','REGION'],
      attributes:{},codes:'/codes/2',concepts:'/concepts/2'}},
    '/structure/2':{body:{id:'industry',version:2,dimensions:['MEASURE','REGION'],
      attributes:{},codes:'/codes/2',concepts:'/concepts/2'}},
    '/codes/2':{status:404,body:{error:'码表未就绪'}},
    '/concepts/2':{body:{id:'industry',version:2,...concepts}}
  });
  try{
    const bundle=await fetchStructureBundle(origin.url);
    assert.equal(bundle.status,'incomplete');
    assert.deepEqual(bundle.missing,[{
      path:'/codes/2',
      reason:'资料读取失败 /codes/2: HTTP 404',
      status:404
    }]);
    assert.ok(bundle.resources.concepts);
    assert.equal(bundle.codes,undefined);
  }finally{
    await origin.close();
  }
});
