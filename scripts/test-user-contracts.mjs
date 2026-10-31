// SPDX-License-Identifier: MIT
// Synthetic privilege, logger and Windows.Data.Json tests need the matching Wine WinRT engine.
// Public services, accounts, game saves and production trust are never used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
if(process.argv.length!==4)throw Error('Usage: test-user-contracts.mjs BUILD_DIRECTORY PINNED_WINE_EXECUTABLE');
const build=fs.realpathSync(process.argv[2]),engine=fs.realpathSync(process.argv[3]);
const base=path.dirname(path.dirname(engine)),bin=path.join(build,'bin');
const names=['xgameruntime.dll','nexus_user-privilege.exe','nexus_auth-metadata.exe','nexus_game-invitations.exe','nexus_legacy-service-client.exe','nexus_auth-rejection-metadata.exe','nexus_store-license-map.exe'];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshot=()=>Object.fromEntries(names.map(x=>[x,hash(path.join(bin,x))]));
const before=snapshot(),root=fs.mkdtempSync(path.join(build,'nexus-user-contract-test-'));fs.chmodSync(root,0o700);
const prefix=path.join(root,'pfx'),env={...process.env,WINEPREFIX:prefix,WINEARCH:'win64',WINEDEBUG:'-all',
  WINEDLLOVERRIDES:'mscoree,mshtml,winemenubuilder.exe=d;xgameruntime=n',LD_LIBRARY_PATH:base+'/lib64:'+base+'/lib'};
for(const key of Object.keys(env))if(/^(XODUS_|XUSER_|NEXUS_|XGAMERUNTIME_|STEAM_COMPAT_|SteamAppId$|SteamGameId$|WINEDLLPATH$|GTEST_)/.test(key))delete env[key];
const proof={scope:'C++ privilege helpers and native API, closed transport and private numeric diagnostics',
  engine,engineHash:hash(engine),binaries:before,realAccounts:false,realCloud:false,fullRuntime:false,results:[]};
let passed=false;
function run(name,command,args,timeout=120000){
 const result=spawnSync(command,args,{env,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
 const output=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(path.join(root,name+'.log'),output,{flag:'wx',mode:0o600});
 if(result.error||result.signal||result.status!==0){proof.failure={name,status:result.status,signal:result.signal,error:result.error?.message};throw Error(name+' failed; see '+root);}
 return output;
}
try{
 run('wineboot',engine,['wineboot.exe','--init']);
 const bytes=fs.readFileSync(path.join(bin,'xgameruntime.dll'));
 const machine=bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4);
 if(machine!==0x8664&&machine!==0x14c)throw Error('Unsupported candidate PE architecture');
 const system=path.join(prefix,'drive_c/windows',machine===0x8664?'system32':'syswow64');
 if(!fs.realpathSync(system).startsWith(prefix+path.sep))throw Error('Prefix system directory escapes test root');
 const staged=path.join(system,'xgameruntime.dll'),temporary=staged+'.nexus-'+process.pid;
 fs.copyFileSync(path.join(bin,'xgameruntime.dll'),temporary,fs.constants.COPYFILE_EXCL);fs.renameSync(temporary,staged);
 if(fs.lstatSync(staged).isSymbolicLink()||hash(staged)!==before['xgameruntime.dll'])throw Error('Exact DLL staging failed');
 for(const [name,minimum]of [['user-privilege',1162],['auth-metadata',200],['game-invitations',86],['legacy-service-client',70],['auth-rejection-metadata',28],['store-license-map',90]]){
  const output=run(name,engine,[path.join(bin,'nexus_'+name+'.exe')]);
  const summary=output.match(/(?:^|\n)CHECKS (\d+) FAILURES (\d+)/);
  if(!summary||Number(summary[1])<minimum||Number(summary[2])||/(?:^|\n)FAIL /.test(output))throw Error(name+' lost required coverage');
  proof.results.push({name,checks:Number(summary[1]),failures:0});
 }
 if(JSON.stringify(snapshot())!==JSON.stringify(before)||hash(staged)!==before['xgameruntime.dll'])throw Error('Candidate changed during validation');
 proof.unchanged=true;proof.staged={machine,sha256:hash(staged)};passed=true;
}finally{
 const server=path.join(path.dirname(engine),'wineserver');
 const stop=spawnSync(server,['-k'],{env,timeout:10000,stdio:'ignore'}),drain=spawnSync(server,['-w'],{env,timeout:10000,stdio:'ignore'});
 if(stop.error||drain.error||drain.status!==0){passed=false;proof.cleanupFailed=true;}
 if(passed&&fs.existsSync(prefix)){
  if(fs.realpathSync(prefix)!==prefix||!fs.lstatSync(prefix).isDirectory())throw Error('Unexpected synthetic prefix');
  fs.rmSync(prefix,{recursive:true});proof.syntheticPrefixRemoved=true;
 }
 proof.passed=passed;fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(root);console.log(JSON.stringify(proof));
}
if(!passed)throw Error('Synthetic user contracts failed');
