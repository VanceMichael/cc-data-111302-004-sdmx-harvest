#!/usr/bin/env node
import {resolve} from 'node:path';
import {createStore} from './store.mjs';
import {harvest,reInterpret} from './harvest.mjs';
import {listSeries,getSeries,listAnomalies,listBundles,listHarvests} from './query.mjs';

function parseArgs(argv){
  const args={};
  for(let i=0;i<argv.length;i++){
    const token=argv[i];
    if(token.startsWith('--')){
      const key=token.slice(2);
      const next=argv[i+1];
      if(next===undefined||next.startsWith('--')){args[key]=true;}
      else{args[key]=next;i++;}
    }
  }
  return args;
}

function print(value){
  process.stdout.write(JSON.stringify(value,null,2)+'\n');
}

async function main(){
  const [command,...rest]=process.argv.slice(2);
  const args=parseArgs(rest);
  const storeDir=resolve(args.store??'.local/harvest');

  if(command==='harvest'||command==='reinterpret'){
    if(!args.source)throw new Error('该命令需要 --source <来源地址>');
    const store=await createStore(storeDir,args.source);
    const result=command==='harvest'
      ?await harvest(store,args.source)
      :await reInterpret(store,args.source);
    print(result);
    return;
  }

  const store=await createStore(storeDir,args.source);
  switch(command){
    case 'series':
      print(args.id?getSeries(store,args.id):listSeries(store));
      break;
    case 'anomalies':
      print(listAnomalies(store,{includeResolved:args.all===true}));
      break;
    case 'bundles':
      print(listBundles(store));
      break;
    case 'harvests':
      print(listHarvests(store));
      break;
    case 'confirm': {
      if(!args.id||!args.version)throw new Error('确认需要 --id <系列标识> --version <结构版本>');
      print(store.confirmInterpretation(args.id,Number(args.version)));
      await store.persist();
      break;
    }
    default:
      process.stderr.write([
        '用法: node src/harvest/cli.mjs <命令> [--store 目录] [--source 地址]',
        '命令:',
        '  harvest       沿数据流定义领取结构与数据并解释',
        '  reinterpret   修订结构到齐后重新解释受影响的原文',
        '  series        查看系列（可加 --id 系列标识）',
        '  anomalies     查看打开的异常（--all 含已解决）',
        '  bundles       查看钉版结构包及其原文哈希',
        '  harvests      查看历次领取记录',
        '  confirm       确认某系列某结构版本的解释（--id --version）'
      ].join('\n')+'\n');
      process.exitCode=1;
  }
}

main().catch(error=>{
  process.stderr.write(`失败: ${error.message}\n`);
  process.exit(1);
});
