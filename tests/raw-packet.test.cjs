'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { prepare } = require('../src/qq/raw-packet.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

test('raw packets reject malformed names, payloads and booleans before native access', async () => {
    let loaded = 0;
    const channel = createChannel({ loadNative() { loaded++; throw new Error('must not load'); } });
    for (const params of [{cmd:'a\n'}, {cmd:'a'.repeat(128)}, {cmd:'a',data:'0'}, {cmd:'a',data:'zz'}, {cmd:'a',data:'00'.repeat(65537)}, {cmd:'a',rsp:'true'}, {cmd:'a',rsp:null}, {cmd:'a',data:null}]) {
        await assert.rejects(channel.run({}, {op:'rawPacket',...params}), {code:'INVALID_PARAMS'});
    }
    assert.equal(loaded, 0);
    assert.equal(prepare({cmd:'Test.Request'}).body.length, 0);
});

function fixture(response = { count:1, result:0, body:[0,255,1] }) {
    const submissions = [], released = [];
    const native = { resetSession() {}, install:()=>({ok:true}), readTemplate:()=>({haveTemplate:true}),
        send(cmd,data) { submissions.push({cmd,data}); return {ok:true,requestId:'1'}; },
        readResponse:()=>({requestId:'1',...response}), release:id=>released.push(id) };
    const channel = createChannel({loadNative:()=>native});
    const capture = {epoch:'e',self:{uin:'123'},closed:false};
    const run = params => channel.run(capture, {op:'rawPacket',cmd:'Test.Request',data:'00ff',...params});
    return {channel,capture,submissions,released,run};
}
test('raw packet responses preserve exact bytes and physical transport statistics', async () => {
    const f = fixture();
    assert.equal((await f.run()).responseHex, '00ff01');
    assert.deepEqual(f.submissions,[{cmd:'Test.Request',data:'00ff'}]);
    assert.deepEqual(f.released,['1']);
    await new Promise(resolve=>setImmediate(resolve));
    const stats=f.channel.statistics();
    assert.equal(stats.includesAllQQTraffic,false);
    assert.deepEqual(stats.counters,{queued:1,submitted:1,response:1,succeeded:1,failed:0,cancelled:0,timed_out:0});
    assert.equal(stats.requestBytes,2); assert.equal(stats.responseBytes,3);
    assert.equal(stats.queued,0); assert.equal(stats.active,false);
});
test('empty raw responses are accepted only with explicit empty-body evidence', async () => {
    assert.equal((await fixture({count:1,result:0,body:[],bodyStatus:'empty',responseBytes:'0'}).run()).responseHex,'');
    await assert.rejects(fixture({count:1,result:0,body:[],bodyStatus:'too_large',responseBytes:'70000'}).run(),{code:'QUERY_FAILED'});
});
test('rsp=false acknowledges only native submission, frees callback, and never reads a response', async () => {
    const f=fixture();
    assert.deepEqual(await f.run({rsp:false,data:''}),{submitted:true,via:'native-msf'});
    assert.deepEqual(f.released,['1']);
    assert.equal(f.channel.statistics().counters.response,0);
});
test('transport failures and wrong request IDs fail without reflecting packet contents', async () => {
    for (const response of [{requestId:'2',count:1,result:0,body:[1]}, {count:1,result:5,body:[115,101,99,114,101,116]}]) {
        const f=fixture(response);
        await assert.rejects(f.run(),error=>{assert.ok(['INVALID_RESPONSE','QUERY_FAILED'].includes(error.code));assert.equal(error.message.includes('secret'),false);return true;});
        assert.deepEqual(f.released,['1']);
        assert.equal(f.channel.statistics().counters.failed,1);
    }
});
test('OneBot packet actions bind UIN and epoch and return their documented response shape', async () => {
    const state={ready:true,epoch:'live',self:{uin:'3000000002',uid:'u_self'},capabilities:{rawPacket:true,packetStatus:true}};
    const calls=[],logs=[];
    const service=new OneBotService({store:{},logger:(event,data)=>logs.push({event,...data}),backend:{async call(method,params){calls.push({method,params});return method==='status'?state:method==='packetStatus'?{scope:'adapter-native-sso'}:params.rsp?{responseHex:'abcd'}:{submitted:true};}}});
    assert.equal((await service.action({action:'send_packet',params:{cmd:'Test.Request',data:'babe'}})).data,'abcd');
    assert.equal((await service.action({action:'.send_packet',params:{cmd:'Test.Request',rsp:false}})).data,null);
    assert.equal((await service.action({action:'nc_get_packet_status'})).data.scope,'adapter-native-sso');
    assert.ok(calls.filter(x=>x.method!=='status').every(x=>x.params.expectedEpoch==='live'&&x.params.expectedUin===state.self.uin));
    assert.equal((await service.action({action:'send_packet',params:{cmd:'Test.Request',data:'babe',rsp:'true'}})).retcode,1400);
    assert.equal(JSON.stringify(logs).includes('babe'),false);
});
test('raw kernel methods cannot accept an unbound or retired account epoch', async t => {
    const capture=new Capture({install:false,qqVersion:TARGET_VERSION});t.after(()=>capture.close());
    capture.ready=true;capture.session={};capture.self={uin:'3000000002',uid:'u_self'};
    for (const method of ['rawPacket','packetStatus']) for(const params of [{},{expectedEpoch:'old',expectedUin:capture.self.uin},{expectedEpoch:capture.epoch,expectedUin:'3000000003'}]) {
        await assert.rejects(capture.call(method,params),{code:'SESSION_CHANGED'});
    }
});
