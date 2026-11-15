<script setup lang="ts">
import { computed, watch } from 'vue';
import StatusBadge from '../components/StatusBadge.vue';
import ContactAvatar from '../components/ContactAvatar.vue';
import EmptyState from '../components/EmptyState.vue';
import UploadField from '../components/UploadField.vue';
import Icon from '../components/Icon.vue';
import type { IconName } from '../components/Icon.vue';
import ResultBlock from '../components/ResultBlock.vue';
import type { Account, Json, MessageState, SocialState } from '../types';

const props = defineProps<{ accounts: Account[]; selectedId: string; busy: boolean; social: SocialState; messages: MessageState }>();
const emit = defineEmits<{
  select: [id: string];
  loadContacts: [];
  queryInfo: [];
  sendMessage: [];
  uploadImage: [file: File];
  uploadFile: [file: File];
  executeAction: [];
}>();
const account = computed(() => props.accounts.find(value => value.id === props.selectedId));
const filteredContacts = computed(() => props.social.contacts.filter(value => JSON.stringify(value).toLocaleLowerCase().includes(props.social.search.toLocaleLowerCase())));
const tabs: { id: 'contacts' | 'messages'; title: string; icon: IconName }[] = [
  { id: 'contacts', title: '好友与群', icon: 'users' },
  { id: 'messages', title: '消息测试', icon: 'send' },
];
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }
watch(() => props.social.kind, () => { props.social.contacts = []; props.social.detail = null; props.social.search = ''; });
</script>

<template>
  <div class="account-selector">
    <label>当前账号
      <select :value="selectedId" :disabled="busy" @change="emit('select', ($event.target as HTMLSelectElement).value)">
        <option value="" disabled>请选择账号</option>
        <option v-for="item in accounts" :key="item.id" :value="item.id">{{ item.label || item.id }} · {{ item.expectedUin || '身份未知' }}</option>
      </select>
    </label>
    <StatusBadge v-if="account" :state="account.state" />
    <span v-if="!accounts.length">请先在 QQ 账号页面创建账号。</span>
  </div>

  <div class="page-tabs" role="tablist" aria-label="好友与消息">
    <button v-for="item in tabs" :key="item.id" role="tab" :aria-selected="social.tab === item.id" :class="{ active: social.tab === item.id }" @click="social.tab = item.id">
      <Icon class="tab-icon" :name="item.icon" :size="16" />{{ item.title }}
    </button>
  </div>

  <template v-if="!selectedId">
    <EmptyState icon="user" title="先选择一个账号" description="好友资料与消息测试都基于当前 QQ 的真实会话。" />
  </template>

  <template v-else-if="social.tab === 'contacts'">
    <section class="panel">
      <div class="section-heading">
        <div><h2>好友与群列表</h2><p>查询结果来自当前 QQ 会话；失败不会显示为成功的空列表。</p></div>
        <div class="button-row">
          <select v-model="social.kind" aria-label="列表类型"><option value="friends">好友列表</option><option value="groups">群列表</option></select>
          <button class="primary" :disabled="busy" @click="emit('loadContacts')">查询列表</button>
        </div>
      </div>
      <input v-model="social.search" class="search" placeholder="搜索已加载的昵称、备注或号码" aria-label="搜索已加载的联系人" />
      <div v-if="!filteredContacts.length" class="empty compact">尚无可展示结果，请先查询。</div>
      <div v-else class="contact-list">
        <button v-for="item in filteredContacts" :key="selectedId + ':' + (item.group_id != null ? 'group:' + item.group_id : 'user:' + item.user_id)" class="contact-row" @click="social.detail = item">
          <ContactAvatar :profile-id="selectedId" :kind="item.group_id != null ? 'group' : 'user'" :id="String(item.group_id ?? item.user_id ?? '')" :label="String(item.remark || item.nickname || item.group_name || '未命名')" />
          <span><strong>{{ item.remark || item.nickname || item.group_name || '未命名' }}</strong><small>{{ item.user_id || item.group_id }}</small></span>
          <span>查看详情 →</span>
        </button>
      </div>
    </section>
    <section class="panel">
      <h2>按号码查询资料</h2>
      <form class="form-grid" @submit.prevent="emit('queryInfo')">
        <label>查询类型<select v-model="social.queryForm.kind"><option value="get_stranger_info">用户资料</option><option value="get_group_info">群资料</option><option value="get_group_member_info">群成员资料</option><option value="get_group_member_list">群成员列表</option></select></label>
        <label>{{ social.queryForm.kind === 'get_stranger_info' ? 'QQ 号' : '群号' }}<input v-model="social.queryForm.id" required inputmode="numeric" /></label>
        <label v-if="social.queryForm.kind === 'get_group_member_info'">成员 QQ 号<input v-model="social.queryForm.member" required inputmode="numeric" /></label>
        <button class="primary align-end" :disabled="busy">查询</button>
      </form>
    </section>
    <section v-if="social.detail" class="panel">
      <h2>资料详情</h2>
      <ResultBlock :value="social.detail" max-height="420px" />
    </section>
  </template>

  <template v-else>
    <section class="panel">
      <div class="section-heading">
        <div><h2>发送一次测试消息</h2><p>此页面会执行真实 QQ 操作，发送前再次确认。</p></div>
        <label class="check"><input v-model="messages.form.advanced" type="checkbox" />消息段 JSON</label>
      </div>
      <form @submit.prevent="emit('sendMessage')">
        <fieldset :disabled="busy">
          <div class="form-grid">
            <label>会话类型<select v-model="messages.form.type"><option value="private">私聊</option><option value="group">群聊</option></select></label>
            <label>{{ messages.form.type === 'private' ? '接收方 QQ' : '接收群号' }}<input v-model="messages.form.recipient" required inputmode="numeric" /></label>
          </div>
          <template v-if="!messages.form.advanced">
            <label>文字内容<textarea v-model="messages.form.text" rows="5" placeholder="保留空格与换行" /></label>
            <div class="form-grid">
              <label>@ QQ / all（群聊）<input v-model="messages.form.at" :disabled="messages.form.type !== 'group'" placeholder="可选" /></label>
              <label>引用 OneBot 消息 ID<input v-model="messages.form.reply" placeholder="可选；必须能在当前会话定位" /></label>
            </div>
          </template>
          <label v-else>消息段数组<textarea v-model="messages.form.segments" rows="10" spellcheck="false" class="code-input" /><small>可填写 text、at、reply 及后端已支持的媒体段。不支持的段由后端整体拒绝。</small></label>
          <UploadField label="上传 PNG / JPEG / GIF 图片" accept="image/png,image/jpeg,image/gif" :disabled="busy" @file="emit('uploadImage', $event)" />
          <p v-if="messages.uploadedImage" class="note">已添加一张暂存图片（{{ messages.form.advanced ? '已插入消息段' : '将随文字一起发送' }}） <button type="button" class="text-button" @click="messages.uploadedImage = ''">取消附加</button></p>
          <button class="primary">核对并发送</button>
        </fieldset>
      </form>
    </section>
    <section class="panel">
      <h2>OneBot 接口调试</h2>
      <p>读取接口直接查询，产生副作用的接口需再次确认。</p>
      <form @submit.prevent="emit('executeAction')">
        <fieldset :disabled="busy">
          <label>接口名称<input v-model="messages.actionName" required list="actions" />
            <datalist id="actions"><option>get_status</option><option>get_login_info</option><option>get_version_info</option><option>get_msg</option><option>get_group_member_list</option><option>get_group_file_url</option><option>upload_private_file</option><option>upload_group_file</option><option>set_group_ban</option><option>set_friend_add_request</option><option>set_group_add_request</option></datalist>
          </label>
          <label>参数 JSON<textarea v-model="messages.actionParams" class="code-input" rows="5" spellcheck="false" /></label>
          <UploadField label="上传文件到接口调试" :disabled="busy" @file="emit('uploadFile', $event)" />
          <p class="note">单文件最大 50 MiB。上传仅暂存并填入当前会话类型、接收方和文件参数；核对后调用接口并确认才会发送。</p>
          <button class="secondary">调用接口</button>
        </fieldset>
      </form>
    </section>
    <section v-if="messages.actionResult" class="panel">
      <h2>接口响应</h2>
      <ResultBlock :value="messages.actionResult" max-height="420px" />
    </section>
  </template>
</template>

<style scoped>
.tab-icon{color:var(--faint)}.account-selector{flex-wrap:wrap}
</style>
