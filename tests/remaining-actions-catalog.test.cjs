'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {capabilities,IMPLEMENTED_ACTIONS}=require('../src/onebot/capabilities.cjs');
const {cancellable,METHODS}=require('../src/ipc/common.cjs');
test('all eighteen former gaps are registered exactly once with honest session-dependent flags',()=>{
 const modules=['word-slices','raw-packet','auth-extra','model-show','url-safety','collection-create','emoji-summary'].map(name=>require('../src/onebot/'+name+'-actions.cjs'));
 const requirements=Object.assign({},...modules.map(m=>m.EXTENSION_REQUIREMENTS),require('../src/onebot/lifecycle-actions.cjs').REQUIREMENTS,require('../src/onebot/anonymous-actions.cjs').ACTION_REQUIREMENTS);
 const original=['_get_model_show','_set_model_show','.get_word_slices','bot_exit','check_url_safely','clean_cache','create_collection','get_clientkey','get_cookies','get_credentials','get_csrf_token','get_msg_emoji_likes','nc_get_packet_status','request_decrypt_key','send_packet','set_restart','set_group_anonymous','set_group_anonymous_ban'];
 const flags=Object.fromEntries(Object.values(requirements).map(key=>[key,true]));
 for(const ready of [false,true]){
  const catalog=capabilities({ready,self:{uin:'12345',uid:'u_self'},capabilities:flags}),all=[...catalog.actions,...catalog.extensions];
  assert.equal(new Set(all.map(x=>x.name)).size,all.length);
  for(const name of original){const rows=all.filter(x=>x.name===name);assert.equal(rows.length,1,name);assert.equal(rows[0].implemented,true,name);assert.equal(rows[0].available,ready,name);assert.equal(IMPLEMENTED_ACTIONS.has(name),true,name);}
 }
});
test('new kernel methods are routed while credential reads and mutations have separate cancellation semantics',()=>{
 for(const method of ['rawPacket','packetStatus','authQuery','modelShow','urlSafetyQuery','collectionCreate','emojiSummaryQuery','anonymousAction'])assert.equal(METHODS.has(method),true,method);
 for(const method of ['rawPacket','collectionCreate','anonymousAction'])assert.equal(cancellable(method,{}),false,method);
 assert.equal(cancellable('modelShow',{operation:'set'}),false);assert.equal(cancellable('modelShow',{operation:'get'}),true);
 for(const method of ['authQuery','packetStatus','urlSafetyQuery','emojiSummaryQuery'])assert.equal(cancellable(method,{}),true,method);
});
