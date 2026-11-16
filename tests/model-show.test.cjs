'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepare, parse, createModelShow } = require('../src/qq/model-show.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const reply = (operation, body) => JSON.stringify({ [operation === 'get' ? '13030' : '13031']: { ret:0, data:{rsp:body} } });
test('model requests use the fixed legacy VIP protocol without synthesizing an IMEI or model variant', () => {
    const get = prepare('get',{model:'A B 中文'},'12345',123,42), url=new URL(get.url), data=JSON.parse(url.searchParams.get('data'));
    assert.equal(url.origin,'https://proxy.vip.qq.com');assert.equal(url.pathname,'/cgi-bin/srfentry.fcgi');
    assert.equal(url.searchParams.get('g_tk'),'42');assert.equal(data['13030'].req.sModel,encodeURIComponent('A B 中文'));
    assert.equal(data['13030'].req.sIMei,''); assert.equal(data['13030'].req.lUin,12345);
    const set=JSON.parse(new URL(prepare('set',{model:'A',modelShow:''},'12345',123,42).url).searchParams.get('data'));
    assert.equal(set['13031'].req.bRecoverDefault,true);
    assert.throws(()=>prepare('set',{model:'A'},'12345',123,42),{code:'INVALID_PARAMS'});
});
test('model catalog requires exact server items and never falls back to echoing request model', () => {
    assert.deepEqual(parse(reply('get',{vItemList:[{sModelShow:'Real server variant',bNeedPay:true}]}),'get'),[{variants:{model_show:'Real server variant',need_pay:true}}]);
    assert.deepEqual(parse(reply('get',{vItemList:[]}),'get'),[]);
    for(const value of ['{}',JSON.stringify({'13030':{data:{rsp:{vItemList:[]}}}}),reply('get',{}),reply('get',{vItemList:[{sModelShow:'A',bNeedPay:0}]})]) assert.throws(()=>parse(value,'get'),{code:'INVALID_RESPONSE'});
});
test('model setting requires explicit method acknowledgement and propagates known business rejection', () => {
    assert.deepEqual(parse(reply('set',{iRet:0}),'set'),{confirmed:true,confirmation:'server_ack'});
    assert.throws(()=>parse(reply('set',{iRet:1}),'set'),{code:'KERNEL_ERROR'});
    assert.throws(()=>parse(JSON.stringify({'13031':{ret:1,data:{rsp:{}}}}),'set'),{code:'KERNEL_ERROR'});
    assert.throws(()=>parse('{}','set'),{code:'INVALID_RESPONSE'});
    for (const value of [{'13031':{ret:0}}, {'13031':{ret:0,data:{rsp:null}}}, {'13031':{ret:0,data:{rsp:{}}}}]) assert.throws(()=>parse(JSON.stringify(value),'set'),{code:'INVALID_RESPONSE'});
    assert.throws(()=>parse(reply('get',{iRet:1,vItemList:[]}),'get'),{code:'KERNEL_ERROR'});
});
function fixture() {
    const capture={epoch:'e',session:{},self:{uin:'12345',uid:'u_self'},ensureReady(){},hasMethods:()=>true,deadline:task=>task()};
    const requests=[];
    const web={async authenticate(){return {p_skey:'fixture-key',key:'42',cookie:url=>{assert.equal(new URL(url).hostname,'proxy.vip.qq.com');return 'fixture-cookie';}};},async request(url,options){requests.push({url,options});return {status:200,text:reply('get',{vItemList:[{sModelShow:'Server variant',bNeedPay:false}]})};}};
    const api=createModelShow(capture,{web});return{capture,web,api,requests};
}
test('model helper keeps current account binding and returns only the parsed business result', async () => {
    const f=fixture(),out=await f.api.execute({operation:'get',model:'A',expectedEpoch:'e'});
    assert.deepEqual(out,{operation:'get',uin:'12345',result:[{variants:{model_show:'Server variant',need_pay:false}}]});
    assert.equal(f.requests.length,1);
    await assert.rejects(f.api.execute({operation:'get',expectedEpoch:'old'}),{code:'SESSION_CHANGED'});
});
test('model helper refuses redirects, missing VIP key, late responses and credential-bearing errors', async () => {
    const f=fixture();
    f.web.request=async()=>({status:302,text:''});await assert.rejects(f.api.execute({operation:'get',expectedEpoch:'e'}),{code:'QUERY_FAILED'});
    f.web.authenticate=async()=>{throw new Error('cookie=PRIVATE');};
    await assert.rejects(f.api.execute({operation:'get',expectedEpoch:'e'}),error=>{assert.equal(error.message.includes('PRIVATE'),false);return true;});
    f.web.authenticate=async()=>({p_skey:''});await assert.rejects(f.api.execute({operation:'get',expectedEpoch:'e'}),{code:'AUTH_FAILED'});
});
test('model OneBot actions preserve reference shapes with real method and session checks', async () => {
    const state={ready:true,epoch:'e',self:{uin:'12345',uid:'u_self'},capabilities:{modelShowRead:true,modelShowSet:true}},calls=[];
    const service=new OneBotService({store:{},backend:{async call(method,params){if(method==='status')return state;calls.push({method,params});return{uin:'12345',operation:params.operation,result:params.operation==='get'?[{variants:{model_show:'Real',need_pay:false}}]:{confirmed:true,confirmation:'server_ack'}};}}});
    assert.deepEqual((await service.action({action:'_get_model_show',params:{model:'A'}})).data,[{variants:{model_show:'Real',need_pay:false}}]);
    assert.equal((await service.action({action:'_set_model_show',params:{model:'A',model_show:''}})).retcode,0);
    assert.equal(calls.every(x=>x.method==='modelShow'&&x.params.expectedEpoch==='e'),true);
    assert.equal((await service.action({action:'_set_model_show'})).retcode,1400);
});
