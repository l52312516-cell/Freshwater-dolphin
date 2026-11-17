<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import SubNav from '../components/SubNav.vue';
import ThemeModeControl from '../components/ThemeModeControl.vue';
import AccentPicker from '../components/AccentPicker.vue';
import Icon from '../components/Icon.vue';
import ResultBlock from '../components/ResultBlock.vue';
import UploadField from '../components/UploadField.vue';
import StoragePanel from '../components/StoragePanel.vue';
import NotificationsPanel from '../components/NotificationsPanel.vue';
import { useTheme } from '../theme';
import type { IconName } from '../components/Icon.vue';
import type { BackupState, Overview, SettingsState, StorageCleanup, StorageCleanupRequest, StorageSnapshot } from '../types';

const props = defineProps<{ overview: Overview; busy: boolean; settings: SettingsState; settingsDirty?: boolean; backup: BackupState; storage: StorageSnapshot | null; storageResult: StorageCleanup | null }>();
const emit = defineEmits<{
  subnav: [id: string];
  saveSettings: [];
  saveGlobalSettings: [];
  loadStorage: [];
  saveStoragePolicy: [policy: { logMaxMiB: number; logRetentionDays: number }];
  cleanupStorage: [request: StorageCleanupRequest];
  loadSettings: [];
  changePassword: [];
  createBackup: [];
  uploadBackup: [file: File];
  previewRestore: [];
  applyRestore: [];
  loadBackups: [];
  download: [id: string];
  deleteBackup: [id: string];
}>();
const { theme, contrasts, setContrast } = useTheme();
const sections: { id: string; title: string; icon: IconName }[] = [
  { id: 'appearance', title: '外观', icon: 'sun' },
  { id: 'global', title: '全局配置', icon: 'grid' },
  { id: 'notifications', title: '通知', icon: 'bell' },
  { id: 'runtime', title: '运行与访问', icon: 'sliders' },
  { id: 'storage', title: '存储管理', icon: 'box' },
  { id: 'password', title: 'WebUI 访问密码', icon: 'lock' },
  { id: 'backup', title: '备份恢复', icon: 'inbox' },
  { id: 'about', title: '关于', icon: 'info' },
];
const section = ref<string>('appearance');
const contrastNames: Record<string, string> = { soft: '柔和', oled: '纯黑（OLED）' };
const revealServiceUrls = ref(false);
const musicUsesKey = computed(() => !props.settings.clearMusicSignKey && (Boolean(props.settings.musicSignKey.trim()) || props.settings.hasMusicSignKey));

function addFallback() {
  if (!props.busy && props.settings.rkey.fallbackServers.length < 8) props.settings.rkey.fallbackServers.push('');
}
function moveFallback(index: number, offset: number) {
  const rows = props.settings.rkey.fallbackServers;
  if (props.busy || index + offset < 0 || index + offset >= rows.length) return;
  [rows[index], rows[index + offset]] = [rows[index + offset]!, rows[index]!];
}
function removeFallback(index: number) {
  if (!props.busy) props.settings.rkey.fallbackServers.splice(index, 1);
}

const summary = computed(() => {
  const rows: { name: string; value: string }[] = [
    { name: '同时运行账号上限', value: String(props.settings.maxAccounts) },
    { name: '对外资源链接地址', value: props.settings.publicBaseUrl || '未设置' },
    { name: '管理台版本', value: props.overview.version || '未知' },
  ];
  return rows;
});

function size(value = 0) {
  return value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MiB' : Math.round(value / 1024) + ' KiB';
}
function date(value?: string | number) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function openSection(id: string) {
  if (sections.some(item => item.id === id)) section.value = id;
}

watch(section, value => emit('subnav', value));
onMounted(() => emit('subnav', section.value));
defineExpose({ openSection });
</script>

<template>
  <div class="settings-layout">
    <SubNav v-model="section" :items="sections" />

    <div class="settings-body">
      <p v-if="settingsDirty" class="notice" role="status">运行或全局配置有尚未保存的修改，切换页面会保留草稿。</p>
      <NotificationsPanel v-if="section === 'notifications'" />
      <template v-else-if="section === 'appearance'">
        <section class="panel">
          <h2>外观</h2>
          <p>配色方案、明暗模式与深色风格。所有改动立即生效，并保存在当前浏览器。</p>
          <div class="settings-block">
            <span class="settings-label">显示模式</span>
            <ThemeModeControl labelled />
            <small>“跟随系统”会随操作系统外观自动切换。</small>
          </div>
          <div class="settings-block">
            <span class="settings-label">强调色</span>
            <AccentPicker />
            <small>色板取自「夜海 · 月华」插画，深浅两套主题各自校准对比度。</small>
          </div>
          <div class="settings-block">
            <span class="settings-label">深色强度</span>
            <div class="theme-segment" role="group" aria-label="深色强度">
              <button v-for="item in contrasts" :key="item" type="button" :class="{ active: theme.contrast === item }" :aria-pressed="theme.contrast === item" @click="setContrast(item)">{{ contrastNames[item] }}</button>
            </div>
            <small>{{ theme.resolved === 'dark' ? '“纯黑”会把画布压到纯黑，适合 OLED 屏幕。' : '仅在深色模式下可见。' }}</small>
          </div>
          <div class="appearance-preview" :class="{ 'is-dark': theme.resolved === 'dark' }">
            <div class="preview-top"><span class="badge running">运行中</span><span class="badge online_unknown">未知</span><span class="badge error">运行错误</span></div>
            <div class="preview-body"><strong>预览</strong><p>正文文本、次要说明与强调色在两种主题下都保持可读。</p><button type="button" class="primary">主操作</button><button type="button" class="secondary">次操作</button></div>
          </div>
        </section>
      </template>

      <template v-else-if="section === 'global'">
        <section class="panel global-settings">
          <div class="section-heading">
            <div><span class="eyebrow">SHARED SERVICES</span><h2>全局配置</h2><p>所有 QQ 账号共用，保存后即时应用，无需重启 QQ。</p></div>
            <span class="badge running">全部账号</span>
          </div>
          <form @submit.prevent="emit('saveGlobalSettings')">
            <fieldset :disabled="busy">
              <div class="global-service-section">
                <div class="global-service-heading"><div><h3>rkey 回退服务器</h3><p>按列表顺序作为回退来源。最多 8 个地址，清空列表即禁用第三方回退。</p></div><button class="secondary" type="button" :disabled="busy || settings.rkey.fallbackServers.length >= 8" @click="addFallback"><Icon name="plus" :size="15" /> 添加服务器</button></div>
                <div v-if="!settings.rkey.fallbackServers.length" class="global-service-empty"><Icon name="server" :size="22" /><div><strong>尚未配置回退服务器</strong><span>需要时添加你信任的服务；默认不连接公共服务。</span></div></div>
                <ol v-else class="fallback-server-list" aria-label="有序 rkey 回退服务器">
                  <li v-for="(_, index) in settings.rkey.fallbackServers" :key="index" class="fallback-server-row">
                    <span class="fallback-order" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
                    <label class="fallback-address"><span class="sr-only">第 {{ index + 1 }} 个 rkey 回退服务器</span><input v-model="settings.rkey.fallbackServers[index]" :type="revealServiceUrls ? 'text' : 'password'" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://your-service.example/rkey" /></label>
                    <div class="fallback-actions"><button type="button" class="icon-button" :aria-label="'上移第 ' + (index + 1) + ' 个服务器'" :disabled="busy || index === 0" @click="moveFallback(index, -1)"><Icon name="chevronUp" :size="16" /></button><button type="button" class="icon-button" :aria-label="'下移第 ' + (index + 1) + ' 个服务器'" :disabled="busy || index === settings.rkey.fallbackServers.length - 1" @click="moveFallback(index, 1)"><Icon name="chevronDown" :size="16" /></button><button type="button" class="icon-button danger-text" :aria-label="'删除第 ' + (index + 1) + ' 个服务器'" @click="removeFallback(index)"><Icon name="trash" :size="16" /></button></div>
                  </li>
                </ol>
              </div>
              <div class="global-service-section">
                <h3>音乐卡片签名</h3><p>按需配置第三方签名 URL；留空禁用，不自动填入或连接公共服务。</p>
                <label>音乐卡片签名 URL<input v-model="settings.musicSignUrl" :type="revealServiceUrls ? 'text' : 'password'" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://apii.xianyuw.cn/api/v1/qq-musicark" /></label>
                <div class="music-key-heading"><span class="settings-label">音乐服务密钥</span><span class="badge" :class="settings.hasMusicSignKey ? 'running' : 'stopped'">{{ settings.hasMusicSignKey ? '密钥已配置' : '密钥未配置' }}</span></div>
                <p class="music-request-mode">请求模式：<strong>{{ musicUsesKey ? '带密钥 GET' : '默认 POST（未配置密钥）' }}</strong></p>
                <label><span class="sr-only">音乐服务密钥</span><input v-model="settings.musicSignKey" type="password" :disabled="settings.clearMusicSignKey" autocomplete="new-password" spellcheck="false" :placeholder="settings.hasMusicSignKey ? '已保存，留空保留；输入新密钥替换' : '按签名服务要求填写，密钥不会回显'" /><small>密钥单独保存，读取设置时只显示是否已配置。显示服务地址不会显示密钥。</small></label>
                <label v-if="settings.hasMusicSignKey" class="check"><input v-model="settings.clearMusicSignKey" type="checkbox" />明确清除已保存的音乐服务密钥</label>
                <p class="note">未配置密钥时默认 POST；已保存或新填密钥时使用 GET，携带 key 和音乐元数据。密钥留空保留旧值，明确清除后切回 POST。更换服务来源（协议、域名或端口）时，需重新填写密钥或明确清除。</p>
                <p class="note">用于 QQ、网易云及自定义音乐卡片发送，保存后对所有账号生效。签名服务异常时整条发送失败，不降级成普通文本。</p>
              </div>
              <label class="check global-reveal"><input v-model="revealServiceUrls" type="checkbox" />显示服务地址<small>地址可能包含私有参数，请勿分享完整截图。</small></label>
              <div class="global-save-row"><p>只接受 HTTP(S) 地址，允许查询参数；保存不会试连服务。</p><div class="button-row"><button class="secondary" type="button" @click="emit('loadSettings')">重新读取</button><button class="primary" type="submit">保存全局配置</button></div></div>
            </fieldset>
          </form>
        </section>
      </template>

      <template v-else-if="section === 'runtime'">
        <section class="panel">
          <h2>访问与运行设置</h2>
          <p>公网独立端口默认 4090。TLS 证书与监听参数由部署配置管理，此处显示当前设置。</p>
          <div class="summary-list">
            <div v-for="row in summary" :key="row.name" class="info-row"><span>{{ row.name }}</span><strong>{{ row.value }}</strong></div>
          </div>
          <ResultBlock :value="settings.text" raw max-height="260px" />
          <form @submit.prevent="emit('saveSettings')">
            <fieldset :disabled="busy">
              <label>同时运行账号上限<input v-model.number="settings.maxAccounts" type="number" min="1" max="16" required /><small>默认 2 个；增加上限前请核对可用内存。</small></label>
              <label>对外资源链接地址<input v-model="settings.publicBaseUrl" type="url" placeholder="https://your-server.example:4090" /><small>填写下游 OneBot 应用可访问的管理台 HTTP(S) 地址，用于签名资源链接；留空不生成外部地址。</small></label>
              <section class="status-command-settings" aria-label="内置状态指令">
                <div class="status-command-heading"><div><span class="eyebrow">BUILT-IN COMMAND</span><h3>内置状态指令</h3><p>向当前 QQ 发送触发词，查看适配器状态。</p></div><span class="badge" :class="settings.statusCommand.enabled ? 'running' : 'stopped'">{{ settings.statusCommand.enabled ? '已开启' : '已关闭' }}</span></div>
                <div class="switch-row"><div class="switch-row-text"><strong>开启状态指令</strong><small>关闭后不响应触发词，不影响 OneBot 连接。</small></div><button type="button" class="switch" :class="{ on: settings.statusCommand.enabled }" role="switch" aria-label="开启内置状态指令" :aria-checked="settings.statusCommand.enabled" @click="settings.statusCommand.enabled = !settings.statusCommand.enabled"><span></span></button></div>
                <label>状态指令触发词<input v-model="settings.statusCommand.trigger" type="text" spellcheck="false" autocomplete="off" placeholder="#fd" required /><small>1–32 个字符，不含控制字符或内部空白；保存时去除首尾空白并转为小写。</small></label>
                <div class="status-command-note"><Icon name="info" :size="16" /><p>收到完全匹配触发词的纯文本消息时，回复版本、平台和适配器运行时长。私聊与群聊均可，任何人都能触发；保存后全部账号即时生效，无需重启 QQ。</p></div>
              </section>
              <div class="button-row"><button class="primary">保存设置</button><button type="button" class="secondary" @click="emit('loadSettings')">重新读取</button></div>
            </fieldset>
          </form>
        </section>
      </template>

      <StoragePanel v-else-if="section === 'storage'" :snapshot="storage" :result="storageResult" :busy="busy" @refresh="emit('loadStorage')" @save-policy="emit('saveStoragePolicy', $event)" @cleanup="emit('cleanupStorage', $event)" />

      <template v-else-if="section === 'password'">
        <section class="panel">
          <h2>修改 WebUI 访问密码</h2>
          <p>此密码用于访问 WebUI 面板。QQ 登录、OneBot token 和备份加密密码分别配置。</p>
          <form @submit.prevent="emit('changePassword')">
            <fieldset :disabled="busy">
              <label>当前密码<input v-model="settings.passwords.currentPassword" type="password" autocomplete="current-password" required /></label>
              <label>新密码<input v-model="settings.passwords.newPassword" type="password" autocomplete="new-password" minlength="12" required /></label>
              <label>确认新密码<input v-model="settings.passwords.confirm" type="password" autocomplete="new-password" minlength="12" required /></label>
              <button class="primary">更新密码并重新登录</button>
            </fieldset>
          </form>
        </section>
      </template>

      <template v-else-if="section === 'backup'">
        <div class="two-columns">
          <section class="panel">
            <h2>创建私有备份</h2>
            <p>普通备份包含脱敏配置与消息 ID 映射；完整加密备份包含所选账号的用户状态。</p>
            <form @submit.prevent="emit('createBackup')">
              <fieldset :disabled="busy">
                <label v-for="item in overview.accounts" :key="item.id" class="check"><input v-model="backup.form.profileIds" :value="item.id" type="checkbox" />{{ item.label }} · {{ item.expectedUin }}</label>
                <label>备份范围<select v-model="backup.form.kind"><option value="ordinary">脱敏配置与消息 ID 映射 · 无 token / 登录数据</option><option value="full">完整加密 · 登录数据 / token / 消息映射</option></select></label>
                <label v-if="backup.form.kind === 'full'">独立加密密码<input v-model="backup.form.password" type="password" minlength="12" autocomplete="new-password" required /><small>不要使用 WebUI 访问密码。密码不会保存在服务器，丢失后无法恢复。</small></label>
                <p class="note">两种备份均短暂停止所选账号以取得一致快照。排除 QQ 程序、缓存、日志及管理台认证；其他账号继续运行。</p>
                <button class="primary">创建备份</button>
              </fieldset>
            </form>
          </section>
          <section class="panel">
            <h2>验证与恢复</h2>
            <UploadField label="上传已有备份" :disabled="busy" @file="emit('uploadBackup', $event)" />
            <form @submit.prevent="emit('previewRestore')">
              <fieldset :disabled="busy">
                <label>选择备份<select v-model="backup.restore.backupId" required><option value="" disabled>请选择备份</option><option v-for="item in backup.list" :key="item.id" :value="item.id">{{ item.id }} · {{ item.kind }}</option></select></label>
                <label>备份解密密码<input v-model="backup.restore.password" type="password" autocomplete="off" placeholder="普通备份无需填写" /></label>
                <button class="secondary">验证并预览</button>
              </fieldset>
            </form>
            <template v-if="backup.restore.preview">
              <ResultBlock :value="backup.restore.preview" max-height="300px" />
              <button class="danger" :disabled="busy || !backup.restore.previewId" @click="emit('applyRestore')">按预览恢复</button>
            </template>
            <p class="note">验证成功后仍需确认恢复。恢复后的账号保持停止，不会自动联网或发送消息。</p>
          </section>
        </div>
        <section class="panel">
          <div class="section-heading"><h2>已保存备份</h2><button class="text-button" :disabled="busy" @click="emit('loadBackups')">刷新</button></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>备份编号</th><th>类型</th><th>创建时间</th><th>大小</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="item in backup.list" :key="item.id">
                  <td>{{ item.id }}</td>
                  <td>{{ item.kind === 'full' ? '完整加密' : '普通配置' }}</td>
                  <td>{{ date(item.at ?? item.createdAt) }}</td>
                  <td>{{ size(item.bytes ?? item.size) }}</td>
                  <td><div class="backup-actions">
                    <button type="button" class="text-button" :disabled="busy" :aria-label="'下载备份 ' + item.id" @click.stop="emit('download', item.id)"><Icon name="download" :size="14" />下载</button>
                    <button type="button" class="text-button danger-text" :disabled="busy" :aria-label="'删除备份 ' + item.id" @click.stop="emit('deleteBackup', item.id)"><Icon name="trash" :size="14" />删除</button>
                  </div></td>
                </tr>
                <tr v-if="!backup.list.length"><td colspan="5" class="empty compact">尚无备份</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <template v-else>
        <section class="panel">
          <h2>关于 Freshwater-dolphin</h2>
          <p>独立维护的 QQ kernel / OneBot v11 适配器管理台。协议适配与应用逻辑分离，下游机器人框架及插件独立部署。</p>
          <div class="summary-list">
            <div class="info-row"><span>管理台版本</span><strong>{{ overview.version || '未知' }}</strong></div>
            <div class="info-row"><span>目标环境</span><strong>Linux x64 · QQ 3.2.35-54395</strong></div>
            <div class="info-row"><span>界面主题</span><strong>{{ theme.resolved === 'dark' ? '夜潮（深色）' : '月白（浅色）' }} · {{ theme.accent }}</strong></div>
          </div>
          <div class="note">程序与镜像更新由部署方显式完成，本页面不自动拉取镜像。管理台不记录 token、QQ 票据或聊天正文到诊断日志。</div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.backup-actions{display:flex;align-items:center;gap:24px;white-space:nowrap}.backup-actions .text-button{display:inline-flex;align-items:center;gap:6px;min-height:36px}
.settings-body{min-width:0}.settings-block{margin:18px 0;padding-bottom:16px;border-bottom:1px solid var(--line-soft)}.settings-block:last-of-type{border-bottom:0}.settings-label{display:block;margin-bottom:10px;font-size: 13px;font-weight:500;color:var(--text)}.settings-block>small{display:block;margin-top:8px;font-size: 12px;line-height:1.7}.appearance-preview{margin-top:20px;padding:18px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.preview-top{display:flex;gap:8px;flex-wrap:wrap}.preview-body{margin-top:14px}.preview-body strong{display:block;font-size: 14px;color:var(--text-strong)}.preview-body p{font-size: 12px;margin:6px 0 12px}.preview-body .primary,.preview-body .secondary{margin-right:8px}.summary-list{margin:16px 0}
.global-settings .eyebrow{display:block;margin-bottom:8px}
.global-settings .section-heading{align-items:flex-start}
.global-settings .section-heading .badge{white-space:nowrap;margin-top:4px}
.music-key-heading{display:flex;align-items:center;gap:12px;margin:20px 0 10px}.music-key-heading .settings-label{margin:0}
.music-request-mode strong{font-weight:500;color:var(--accent)}
.status-command-settings{margin:22px 0;padding:20px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.status-command-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.status-command-heading h3{font-size:15px;margin:7px 0 6px}.status-command-heading p{font-size:12px;margin:0;color:var(--faint);line-height:1.7}.status-command-heading>.badge{flex-shrink:0;white-space:nowrap}.status-command-settings .switch-row{margin:10px 0 18px}.status-command-note{display:flex;align-items:flex-start;gap:9px;color:var(--accent);padding-top:2px}.status-command-note>.icon{margin-top:3px}.status-command-note p{font-size:12px;line-height:1.9;color:var(--muted);margin:0}
.global-service-section{padding:22px 0;border-top:1px solid var(--line-soft)}
.global-service-section h3{font-size:15px;margin:0 0 8px}
.global-service-section p{font-size:12px;line-height:1.8;margin:0 0 16px;color:var(--muted)}
.global-service-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.global-service-heading>div{min-width:0}
.global-service-heading>button{flex-shrink:0}
.global-service-empty{display:flex;align-items:center;gap:14px;padding:20px;background:var(--surface-2);border:1px dashed var(--line-strong);border-radius:var(--radius-sm)}
.global-service-empty>.icon{color:var(--accent)}
.global-service-empty strong,.global-service-empty span{display:block}
.global-service-empty strong{font-size:13px;font-weight:500;color:var(--text)}
.global-service-empty span{font-size:12px;line-height:1.8;margin-top:4px;color:var(--faint)}
.fallback-server-list{padding:0;margin:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.fallback-server-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:10px;padding:12px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}
.fallback-order{font-size:12px;font-variant-numeric:tabular-nums;color:var(--accent);text-align:center}
.fallback-address{min-width:0;margin:0}
.fallback-address input{margin:0}
.fallback-actions{display:flex;align-items:center;gap:2px}
.global-reveal{flex-wrap:wrap;gap:8px}
.global-reveal>small{flex-basis:100%;margin-left:24px;font-size:12px;color:var(--faint)}
.global-save-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:20px;border-top:1px solid var(--line-soft)}
.global-save-row>p{font-size:12px;line-height:1.8;color:var(--faint);margin:0;max-width:280px}
.global-save-row>.button-row{flex-shrink:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){.global-service-heading{display:block}.global-service-heading>button{margin-bottom:16px}.fallback-server-row{grid-template-columns:22px minmax(0,1fr);gap:8px;padding:10px}.fallback-actions{grid-column:2;justify-content:flex-end}.global-save-row{align-items:stretch;flex-direction:column}.global-save-row>p{max-width:none}.global-save-row>.button-row{justify-content:flex-end}.global-settings .section-heading{gap:12px}.global-service-empty{align-items:flex-start;padding:15px}}
</style>
