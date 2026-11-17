'use strict';

// QQ owns its session. Observe its normal creation and initialization rather
// than constructing a second session or persisting authentication parameters.
const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const media = require('./media.cjs');
const { createSocial } = require('./social.cjs');
const { validateMusicCard } = require('./music.cjs');
const { createFileUploadObserver } = require('./private-file-upload-observer.cjs');
const path = require('node:path');
const fs = require('node:fs');
const runtimeProfile = require('./runtime-profile.cjs');
const { annotate } = require('../diagnostics.cjs');
const { createAudioProcessor } = require('./audio.cjs');
const { downloadVideo } = require('./video-download.cjs');
const { kickMember } = require('./group-kick.cjs');
const { createInteractions } = require('./interactions.cjs');
const { createGroupFiles } = require('./group-files.cjs');
const { isGrayTip } = require('./gray-tip.cjs');
const { createShareCards } = require('./share-card.cjs');
const { createVideoProcessor } = require('./video-send.cjs');
const { createForward } = require('./forward.cjs');
const { createForwardResourceRead } = require('./forward-resource-read.cjs');
const { createMergedSend } = require('./merged-send.cjs');
const { createExtended } = require('./extended.cjs');
const { createGroupQueries } = require('./group-queries.cjs');
const { createCollectionQueries } = require('./collection-queries.cjs');
const { createAccountQueries } = require('./account-queries.cjs');
const { createExtendedQueries2 } = require('./extended-queries2.cjs');
const { createShareQueries } = require('./share-queries.cjs');
const { createAdminQueries } = require('./admin-queries.cjs');
const { createCustomFace } = require('./custom-face.cjs');
const { createContactExtra } = require('./contact-extra.cjs');
const { createFlashTransfer } = require('./flash-transfer.cjs');
const { createQzone } = require('./qzone.cjs');
const { createFriendDress } = require('./friend-dress.cjs');
const { createForwardUpload } = require('./forward-upload.cjs');
const { createCustomMergedResource } = require('./custom-merged-resource.cjs');
const { createVoiceExtra } = require('./voice-extra.cjs');
const { createGroupAlbum } = require('./group-album.cjs');
const { createMiscExtra } = require('./misc-extra.cjs');
const { createAuthExtra } = require('./auth-extra.cjs');
const { createModelShow } = require('./model-show.cjs');
const { createUrlSafety } = require('./url-safety.cjs');
const { createCollectionCreate } = require('./collection-create.cjs');
const { createEmojiSummary } = require('./emoji-summary.cjs');
const { createAnonymous } = require('./anonymous.cjs');
const { createRecordExporter } = require('./record-export.cjs');
const { integer: profileInteger, groupFields, memberFields, userFields } = require('./profile-fields.cjs');

const TARGET_VERSION = '3.2.35-54395';
const MAX_IDENTITIES = 20000;
const SERVICES = Object.freeze({ msg: 'getMsgService', profile: 'getProfileService',
  group: 'getGroupService', buddy: 'getBuddyService', msf: 'getMSFService', recent: 'getRecentContactService', richMedia: 'getRichMediaService', profileLike: 'getProfileLikeService', collection: 'getCollectionService', ticket: 'getTicketService', tipOff: 'getTipOffService' });
const METHODS = new Set(['status', 'resolve', 'user', 'friends', 'groups', 'groupInfo',
  'groupMember', 'groupMembers', 'getMessage', 'history', 'recall', 'prepareMedia', 'prepareMusic', 'prepareShare', 'receiveMedia', 'imageInfo', 'groupAction', 'socialQuery', 'socialAction', 'interaction', 'groupFiles', 'forwardOperation', 'sendMessage', 'nativeRkey', 'nativeGroupFileUrl', 'nativeGroupFileSpace', 'nativePrivateFileUrl', 'nativeStatus', 'rawPacket', 'packetStatus', 'authQuery', 'modelShow', 'urlSafetyQuery', 'urlSafetyNativeQuery', 'collectionCreate', 'emojiSummaryQuery', 'anonymousAction', 'extendedQuery', 'extendedQuery2', 'shareQuery', 'adminQuery', 'adminAction', 'customFaceQuery', 'customFaceAction', 'contactExtra', 'flashTransfer', 'qzoneQuery', 'qzoneAction', 'voiceExtra', 'forwardUpload', 'friendDressQuery', 'groupAlbumQuery', 'groupAlbumAction', 'miscExtra', 'extendedAction', 'recordExport', 'groupQuery', 'collectionQuery', 'accountQuery']);

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function wrapperDigest(file) {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest('hex'); }
  finally { fs.closeSync(fd); }
}
function numeric(value, label = 'QQ number') {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw problem('INVALID_PARAMS', `Invalid ${label}`);
  }
  return text;
}
function ntuid(value) {
  if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(value)) {
    throw problem('INVALID_PARAMS', 'Expected a kernel UID');
  }
  return value;
}
function plainPeer(value) {
  if (!value || ![1, 2].includes(value.chatType)) throw problem('INVALID_PARAMS', 'Invalid peer');
  return { chatType: value.chatType, peerUid: value.chatType === 1
    ? ntuid(value.peerUid) : numeric(value.peerUid, 'group number') };
}
function confirmed(result) {
  if (!result || result.result !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the request');
  return result;
}
// Kernel bridge versions expose result/error codes as either JSON numbers or
// decimal strings. Media completion and acceptance must treat only an exact
// numeric zero in either representation as success; truthiness would turn a
// string such as "170013002" into an accidental success.
function zeroCode(value) { return value === 0 || value === '0'; }
function initOutcome(args) {
  const first = args[0];
  if (args.length === 0 || first === undefined || first === true || first === 0) return true;
  if (first === false || (typeof first === 'number' && first !== 0)) return false;
  if (first && typeof first === 'object') {
    const codes = ['result', 'errCode', 'errorCode'].filter(key => Object.hasOwn(first, key)).map(key => first[key]);
    if (codes.length && codes.every(code => code === 0)) return true;
    if (codes.length && codes.some(code => typeof code === 'number' && code !== 0)) return false;
  }
  return null;
}
function mapValue(value, key) { return value instanceof Map ? value.get(key) : undefined; }
function sex(value) { return value === 1 ? 'male' : value === 2 ? 'female' : 'unknown'; }
function listener(methods) {
  // Kernel versions call many listener methods; unhandled callbacks must remain
  // harmless while the few supported ones retain stable function identities.
  const cache = new Map();
  return new Proxy(methods, { get(target, name, receiver) {
    if (Reflect.has(target, name)) return Reflect.get(target, name, receiver);
    if (typeof name !== 'string' || !/^on[A-Z]/.test(name)) return undefined;
    if (!cache.has(name)) cache.set(name, () => {});
    return cache.get(name);
  } });
}

function viewOf(original, overrides, bindMethods = false, invocation = {}) {
  // An empty extensible target avoids Proxy invariant violations when QQ's
  // native export properties themselves are frozen. The real objects remain
  // the receivers of all forwarded calls.
  const shell = typeof original === 'function' ? function () {}.bind(null) : Object.create(null);
  const bound = new Map();
  return new Proxy(shell, {
    get(_target, key) {
      if (overrides.has(key)) return overrides.get(key);
      const value = Reflect.get(original, key, original);
      if (!bindMethods || typeof value !== 'function') return value;
      if (!bound.has(key)) bound.set(key, value.bind(original));
      return bound.get(key);
    },
    set(_target, key, value) { return Reflect.set(original, key, value, original); },
    has(_target, key) { return key in original; },
    ownKeys() { return Reflect.ownKeys(original); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() { return Reflect.getPrototypeOf(original); },
    apply(_target, receiver, args) { return invocation.apply ? invocation.apply(original, receiver, args) : Reflect.apply(original, receiver, args); },
    construct(_target, args, newTarget) { return invocation.construct ? invocation.construct(original, args, newTarget) : Reflect.construct(original, args, original); }
  });
}

class Capture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.processObject = options.processObject || process;
    this.log = options.log || (() => {});
    this.versionHint = options.qqVersion || this.processObject.env?.FWD_QQ_VERSION || '';
    this.runtimeIdentity = options.runtimeIdentity || {};
    this.observedWrapperHash = null;
    this.mediaDirectory = options.mediaDirectory || this.processObject.env?.FWD_MEDIA_DIR || null;
    this.mediaTargetRoots = options.mediaTargetRoots || ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map(name => this.processObject.env?.[name]).filter(Boolean);
    this.audio = options.audioProcessor || createAudioProcessor({ root: this.processObject.env?.FWD_MANAGER_ROOT || path.resolve(__dirname, '../..'), mediaDirectory: this.mediaDirectory });
    this.video = options.videoProcessor || createVideoProcessor({ root: this.processObject.env?.FWD_MANAGER_ROOT || path.resolve(__dirname, '../..'), mediaDirectory: this.mediaDirectory });
    this.recordExporter = options.recordExporter || createRecordExporter({ root: this.processObject.env?.FWD_MANAGER_ROOT || path.resolve(__dirname, '../..'), mediaDirectory: this.mediaDirectory });
    this.preparedMedia = new Map();
    this.sendDiagnostics = [];
    this.preparedMusic = new Map();
    this.shareCards = createShareCards(this);
    this.receivedMedia = new Map();
    this.qqVersion = this.versionHint;
    this.epoch = randomUUID();
    this.ready = false;
    this.readyAt = null;
    this.online = null;
    this.self = null;
    this.session = null;
    this.closed = false;
    this.restorations = [];
    this.registrations = [];
    this.observerGeneration = 0;
    this.pending = new Set();
    this.queries = new Map();
    this.memberMutations = new Set();
    this.forward = new Map();
    this.reverse = new Map();
    this.factories = new WeakSet();
    this.exportViews = new WeakMap();
    this.sessions = new WeakSet();
    this.userDetailSchemaLogged = false;
    // null means no complete snapshot has been observed. An empty array is a
    // confirmed complete snapshot, never an initialization default.
    this.groupList = null;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
    this.originalDlopen = null;
    this.observerTimer = null;
    this.social = createSocial(this);
    this.interactions = createInteractions(this);
    this.groupFilesApi = createGroupFiles(this);
    this.forwardApi = createForward(this);
    this.forwardResourceReadApi = createForwardResourceRead(this);
    this.mergedSendApi = createMergedSend(this);
    this.customMergedResourceApi = createCustomMergedResource(this);
    this.extendedApi = createExtended(this);
    this.groupQueriesApi = createGroupQueries(this);
    this.collectionQueries = createCollectionQueries(this);
    this.accountQueriesApi = createAccountQueries(this);
    this.extendedQueries2Api = createExtendedQueries2(this);
    this.shareQueriesApi = createShareQueries(this);
    this.adminQueriesApi = createAdminQueries(this);
    this.customFaceApi = createCustomFace(this);
    this.contactExtraApi = createContactExtra(this);
    this.flashTransferApi = createFlashTransfer(this);
    this.qzoneApi = createQzone(this);
    this.friendDressApi = createFriendDress(this);
    this.forwardUploadApi = createForwardUpload(this);
    this.voiceExtraApi = createVoiceExtra(this);
    this.groupAlbumApi = createGroupAlbum(this);
    this.miscExtraApi = createMiscExtra(this);
    this.modelShowApi = createModelShow(this);
    this.urlSafetyApi = createUrlSafety(this);
    this.collectionCreateApi = createCollectionCreate(this);
    this.emojiSummaryApi = createEmojiSummary(this);
    this.anonymousApi = createAnonymous(this);
    const accountRoot = this.processObject.env?.FWD_ACCOUNT_ROOT;
    this.authExtraApi = createAuthExtra(this, { databaseRoots: typeof accountRoot === 'string' && path.isAbsolute(accountRoot) ?
      [path.join(accountRoot, 'config/QQ'), path.join(accountRoot, 'home/.config/QQ')] : [] });
    require('./msf-native.cjs').bindProfile(() => this.runtimeProfile());
    if (options.install !== false) this.install();
  }

  diagnostic(error) { try { this.log({ code: error?.code || 'CAPTURE_ERROR', message: error?.message || String(error) }); } catch {} }
  runtimeProfile() {
    const env = this.processObject.env || {};
    return runtimeProfile.fromEnvironment(env, { platform: this.processObject.platform || 'linux', architecture: this.processObject.arch || 'x64',
      ...this.runtimeIdentity, qqVersion: this.qqVersion,
      // An environment assertion alone cannot certify the native module that
      // was actually loaded. Hash the observed loader target before enabling it.
      wrapperSha256: this.observedWrapperHash || this.runtimeIdentity.wrapperSha256 || null });
  }
  state() {
    const profile = this.runtimeProfile();
    const compatible = profile.admission !== 'denied';
    const observed = this.registrations.some(value => value.name === 'msg');
    const messageEvents = compatible && this.ready && observed;
    const groupEvents = compatible && this.ready && this.registrations.some(value => value.name === 'group');
    const resolve = compatible && this.ready &&
      ((this.hasMethods('profile', ['getUidByUin']) || this.hasMethods('group', ['getUidByUins'])) &&
        (this.hasMethods('profile', ['getUinByUid']) || this.hasMethods('group', ['getUinByUids'])));
    const text = messageEvents && this.hasMethods('msg', ['sendMsg', 'generateMsgUniqueId']) && this.hasMethods('msf', ['getServerTime']);
    const member = groupEvents && resolve && this.hasMethods('group', ['getMemberInfo']);
    return { epoch: this.epoch, ready: this.ready && !this.closed, readyAt: this.readyAt, online: this.online,
      self: this.self ? { ...this.self } : null, qqVersion: this.qqVersion, runtime_profile: profile,
      // Bounded scalar evidence remains available even when QQ redirects its
      // console. It contains no message IDs, peers, contents, paths or tokens.
      sendDiagnostics: this.sendDiagnostics.map(value => ({ ...value, ...(value.privateFileUpload
        ? { privateFileUpload: structuredClone(value.privateFileUpload) } : {}) })),
      forwardDiagnostics: this.forwardApi.diagnostics?.() || [],
      capabilities: runtimeProfile.limitFlags(profile, { compatible, messages: messageEvents, text, at: text && member,
        wordSlices: typeof Intl.Segmenter === 'function', packetStatus: compatible && this.ready,
        rawPacket: compatible && this.ready && require('./msf-native.cjs').available(this),
        reply: text && (this.hasMethods('msg', ['getMsgsByMsgId']) || this.hasMethods('msg', ['getSingleMsg'])),
        resolve, user: resolve && this.hasMethods('profile', ['getCoreAndBaseInfo']),
        friends: compatible && this.ready && this.hasMethods('buddy', ['getBuddyListV2']) && this.hasMethods('profile', ['getCoreAndBaseInfo']),
        groups: groupEvents && this.hasMethods('group', ['getGroupList']),
        groupInfo: groupEvents && this.hasMethods('group', ['getGroupDetailInfo']), groupMember: member,
        groupMembers: compatible && this.ready && this.hasMethods('group', ['getAllMemberList']),
        history: messageEvents && this.hasMethods('msg', ['getMsgsIncludeSelf', 'getAioFirstViewLatestMsgs']),
        recall: messageEvents && this.hasMethods('msg', ['recallMsg']),
        recallNotice: messageEvents, pokeNotice: messageEvents && resolve, face: text, music: text, share: false, jsonReceive: messageEvents,
        image: text && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getRichMediaFilePathForGuild']),
        file: text && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getRichMediaFilePathForGuild']),
        record: text && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getRichMediaFilePathForGuild']) && this.audio.available(),
        video: text && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getRichMediaFilePathForGuild']) && this.video.available(),
        imageReceive: messageEvents && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getMsgsByMsgId']),
        // A real PTT cache file can be exported even when this QQ build does
        // not expose downloadRichMedia. No local file still fails explicitly.
        recordReceive: messageEvents && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getMsgsByMsgId']),
        recordReceiveDownload: messageEvents && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getMsgsByMsgId', 'downloadRichMedia']),
        videoReceive: messageEvents && typeof this.mediaDirectory === 'string' && this.mediaTargetRoots.length > 0 && this.hasMethods('msg', ['getMsgsByMsgId']) && require('./msf-native.cjs').available(this),
        groupName: compatible && this.ready && this.hasMethods('group', ['modifyGroupName']),
        groupWholeBan: compatible && this.ready && this.hasMethods('group', ['setGroupShutUp']),
        groupMemberBan: member && this.hasMethods('group', ['setMemberShutUp']),
        groupLeave: compatible && this.ready && this.hasMethods('group', ['quitGroupV2']),
        groupCard: member && this.hasMethods('group', ['modifyMemberCardName']),
        groupKick: compatible && this.ready && resolve && this.hasMethods('group', ['kickMember', 'getAllMemberList']),
        groupAdmin: member && this.hasMethods('group', ['modifyMemberRole']), ...this.social.capabilities(),
        ...this.interactions.capabilities(), ...this.groupFilesApi.capabilities(),
        groupFileUrl: compatible && this.ready && require('./msf-native.cjs').available(this),
        groupFileSpace: compatible && this.ready && require('./msf-native.cjs').available(this),
        privateFileUrl: compatible && this.ready && require('./msf-native.cjs').available(this),
        downloadRkey: compatible && this.ready && require('./msf-native.cjs').available(this),
        ...(compatible && this.ready ? this.forwardApi.capabilities() : { forwardExisting: false, forwardRead: false }),
        mergeCustom: compatible && this.ready && text && this.mergedSendApi.capabilities().mergeCustom,
        mergeCustomMetadata: compatible && this.ready && text && this.customMergedResourceApi.capabilities().mergeCustomMetadata,
        recordExport: compatible && this.ready && this.recordExporter.available(),
        ...(compatible && this.ready ? { ...this.extendedApi.capabilities(), ...this.groupQueriesApi.capabilities(),
          ...this.collectionQueries.capabilities(), ...this.accountQueriesApi.capabilities(), ...this.extendedQueries2Api.capabilities(),
          ...this.shareQueriesApi.capabilities(), ...this.adminQueriesApi.capabilities(), ...this.customFaceApi.capabilities(),
          ...this.contactExtraApi.capabilities(), ...this.flashTransferApi.capabilities(), ...this.qzoneApi.capabilities(),
          ...this.groupAlbumApi.capabilities(), ...this.miscExtraApi.capabilities(), ...this.friendDressApi.capabilities(), ...this.forwardUploadApi.capabilities(), ...this.voiceExtraApi.capabilities(), ...this.authExtraApi.capabilities(), ...this.modelShowApi.capabilities(), ...this.urlSafetyApi.capabilities(), ...this.collectionCreateApi.capabilities(), ...this.emojiSummaryApi.capabilities(), ...this.anonymousApi.capabilities() } : {}) }) };
  }
  publish(event) { this.emit('event', { ...event, epoch: this.epoch, selfUin: this.self?.uin || null }); }
  publishState() { this.publish({ kind: 'state', status: this.state() }); }
  ensureReady() {
    this.ensureSessionReady();
    if (this.runtimeProfile().admission === 'denied') throw annotate(problem('UNSUPPORTED', 'QQ runtime profile is not admitted'),
      { reason: 'runtime_profile_denied', phase: 'session' });
  }
  ensureSessionReady() {
    if (this.closed || !this.ready || !this.session) throw problem('NOT_READY', 'QQ session is not ready');
  }
  service(name) {
    this.ensureSessionReady();
    const getter = SERVICES[name];
    if (!getter || typeof this.session[getter] !== 'function') throw problem('UNSUPPORTED', `QQ lacks ${name} service`);
    const value = Reflect.apply(this.session[getter], this.session, []);
    if (!value) throw problem('NOT_READY', `QQ ${name} service is unavailable`);
    return value;
  }
  hasMethods(name, methods) {
    try { const object = this.service(name); return methods.every(method => typeof object[method] === 'function'); }
    catch { return false; }
  }
  invoke(name, method, args) {
    const object = this.service(name);
    if (typeof object[method] !== 'function') throw problem('UNSUPPORTED', `QQ lacks ${name}.${method}`);
    return Reflect.apply(object[method], object, args);
  }

  replace(object, key, make) {
    if (!object || typeof object[key] !== 'function') return false;
    const own = Object.getOwnPropertyDescriptor(object, key);
    const original = object[key];
    const replacement = make(original);
    try {
      Object.defineProperty(object, key, { ...own, value: replacement,
        configurable: own ? own.configurable : true, writable: own ? own.writable : true });
    } catch { return false; }
    this.restorations.push(() => {
      if (object[key] !== replacement) return;
      if (own) Object.defineProperty(object, key, own); else delete object[key];
    });
    return true;
  }

  install() {
    if (this.originalDlopen) return this;
    if (typeof this.processObject.dlopen !== 'function') throw problem('UNSUPPORTED', 'Native module loader is unavailable');
    const capture = this;
    this.originalDlopen = this.processObject.dlopen;
    const original = this.originalDlopen;
    this.dlopenHook = function (module, filename, ...args) {
      const result = Reflect.apply(original, this, [module, filename, ...args]);
      if (!capture.closed && /(?:^|[\\/])wrapper\.node$/i.test(String(filename))) {
        try {
          const stat = fs.lstatSync(filename);
          if (stat.isFile() && !stat.isSymbolicLink()) capture.observedWrapperHash = wrapperDigest(filename);
        } catch { capture.observedWrapperHash = null; }
        try { module.exports = capture.observeExports(module.exports); } catch (error) { capture.diagnostic(error); }
      }
      return result;
    };
    this.processObject.dlopen = this.dlopenHook;
    return this;
  }

  observeExports(exports) {
    if (!exports || !['object', 'function'].includes(typeof exports)) return exports;
    if (this.exportViews.has(exports)) return this.exportViews.get(exports);
    const factory = exports.NodeIQQNTWrapperSession;
    if (!factory || this.factories.has(factory)) {
      this.exportViews.set(exports, exports);
      return exports;
    }
    this.factories.add(factory);
    const capture = this;
    let watched = false;
    const overrides = new Map();
    for (const method of ['create', 'get', 'getNTWrapperSession']) {
      const original = factory[method];
      if (typeof original !== 'function') continue;
      const wrapped = function (...args) {
        const value = Reflect.apply(original, factory, args);
        try { capture.observeSession(value); } catch (error) { capture.diagnostic(error); }
        return value;
      };
      overrides.set(method, wrapped);
      watched = this.replace(factory, method, () => wrapped) || watched;
    }
    if (!overrides.size) throw problem('UNSUPPORTED', 'QQ session factory cannot be observed');
    const unwrappedMethod = [...overrides].some(([key, value]) => factory[key] !== value);
    const result = !watched || unwrappedMethod
      ? viewOf(exports, new Map([['NodeIQQNTWrapperSession', viewOf(factory, overrides)]])) : exports;
    this.exportViews.set(exports, result);
    return result;
  }

  resetSession(session, config) {
    this.rejectPending(problem('SESSION_CHANGED', 'QQ session changed'));
    this.sendDiagnostics.length = 0;
    clearInterval(this.observerTimer); this.observerTimer = null;
    this.detach();
    this.session = session;
    this.epoch = randomUUID();
    this.social.reset();
    this.groupQueriesApi.clear();
    this.extendedQueries2Api.clear();
    this.contactExtraApi.clear();
    this.flashTransferApi.clear(); this.qzoneApi.clear(); this.friendDressApi.clear(); this.voiceExtraApi.clear(); this.authExtraApi.clear(); this.modelShowApi.clear(); this.urlSafetyApi.clear(); this.collectionCreateApi.clear(); this.emojiSummaryApi.clear(); this.anonymousApi.clear();
    this.ready = false;
    this.readyAt = null;
    this.online = null;
    this.groupList = null;
    this.forward.clear(); this.reverse.clear(); this.queries.clear();
    this.forwardApi.clear();
    this.preparedMedia.clear();
    this.preparedMusic.clear();
    this.shareCards.clear();
    this.receivedMedia.clear();
    this.self = null;
    this.userDetailSchemaLogged = false;
    // Never retain or serialize config: it includes authentication tickets.
    if (config && typeof config === 'object') {
      const uin = String(config.selfUin ?? '');
      const uid = String(config.selfUid ?? '');
      if (/^[1-9]\d*$/.test(uin) && /^u_[A-Za-z0-9_-]+$/.test(uid)) {
        this.self = { uin, uid, nickname: '' };
        this.remember(uin, uid);
      }
      const client = String(config.clientVer ?? '');
      this.qqVersion = this.versionHint && client === this.versionHint.split('-')[0] ? this.versionHint : client || this.versionHint;
    }
    this.publishState();
  }

  observeSession(session) {
    if (!session || typeof session !== 'object' || this.sessions.has(session)) return;
    this.sessions.add(session);
    const capture = this;
    if (!this.replace(session, 'init', original => function (...args) {
      capture.resetSession(session, args[0]);
      const epoch = capture.epoch;
      const completion = args[3];
      const callback = completion?.onSessionInitComplete;
      const wrapped = typeof callback === 'function' ? function (...values) {
        const result = Reflect.apply(callback, completion, values);
        if (capture.epoch === epoch && !capture.closed) {
          const outcome = initOutcome(values);
          if (outcome === true) {
            if (capture.readyAt === null) capture.readyAt = Date.now();
            capture.ready = true;
            try { capture.attach(); } catch (error) { capture.diagnostic(error); }
            capture.retryObservers();
            capture.publishState();
          } else {
            capture.withdrawReady(problem('NOT_READY', 'QQ initialization was not confirmed'));
            if (outcome === null) {
              const first = values[0];
              const keys = first && typeof first === 'object' ? Object.keys(first).sort().join(',') : '';
              capture.diagnostic(problem('UNKNOWN_INIT_RESULT', `Initialization callback schema: count=${values.length}; type=${first === null ? 'null' : typeof first}; keys=${keys}`));
            }
          }
        }
        return result;
      } : null;
      const installed = wrapped && capture.replace(completion, 'onSessionInitComplete', () => wrapped);
      if (!installed && wrapped) args[3] = viewOf(completion, new Map([['onSessionInitComplete', wrapped]]), true);
      if (!wrapped) capture.diagnostic(problem('UNSUPPORTED', 'Session completion callback cannot be observed'));
      try { return Reflect.apply(original, this, args); }
      catch (error) {
        if (capture.epoch === epoch && !capture.closed) capture.withdrawReady(problem('NOT_READY', 'QQ initialization threw an exception'));
        throw error;
      }
    })) throw problem('UNSUPPORTED', 'QQ session init cannot be observed');
  }
  withdrawReady(error) {
    this.ready = false;
    this.readyAt = null;
    this.online = null;
    this.shareCards.clear();
    this.groupQueriesApi.clear();
    this.extendedQueries2Api.clear();
    this.contactExtraApi.clear();
    this.flashTransferApi.clear(); this.qzoneApi.clear(); this.friendDressApi.clear(); this.voiceExtraApi.clear(); this.authExtraApi.clear(); this.modelShowApi.clear(); this.urlSafetyApi.clear(); this.collectionCreateApi.clear(); this.emojiSummaryApi.clear(); this.anonymousApi.clear();
    clearInterval(this.observerTimer); this.observerTimer = null;
    this.rejectPending(error);
    this.detach();
    this.publishState();
  }

  attach() {
    if (this.runtimeProfile().admission === 'denied') return;
    const epoch = this.epoch, generation = this.observerGeneration;
    const active = fn => (...args) => { if (!this.closed && this.ready && this.epoch === epoch && this.observerGeneration === generation) {
      try { fn(...args); } catch (error) { this.diagnostic(error); }
    } };
    const msg = listener({
      ...Object.fromEntries(Object.entries(this.social.listenerMethods.msg).map(([name, method]) => [name, active(method)])),
      ...Object.fromEntries(Object.entries(this.extendedQueries2Api.listenerMethods?.msg || {}).map(([name, method]) => [name, active(method)])),
      ...Object.fromEntries(Object.entries(this.groupFilesApi.listenerMethods.msg).map(([name, method]) => [name, active(method)])),
      // Private synchronous observers can preserve an early native record
      // before QQ clears pending-build metadata. This is not a business event.
      onAddSendMsg: active(record => {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          this.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [record] });
        }
      }),
      onRecvMsg: active(records => {
        if (!Array.isArray(records)) return;
        for (const record of records) {
          if (!record || ![1, 2].includes(record.chatType)) continue;
          this.remember(record.senderUin, record.senderUid);
          if (record.chatType === 1) this.remember(record.peerUin, record.peerUid);
          this.publish(isGrayTip(record) ? { kind: 'notice', notice: 'gray_tip', record } : { kind: 'message', record });
        }
      }),
      onMsgInfoListUpdate: active(records => { if (Array.isArray(records)) {
        this.bus.emit('sendObservation', { callback: 'onMsgInfoListUpdate', records });
        this.bus.emit('sent', records);
        for (const record of records) {
          if (![1, 2].includes(record?.chatType) || !Array.isArray(record.elements)) continue;
          const time = Number(record.recallTime);
          if (!Number.isFinite(time) || time <= 0) continue;
          const revoke = record.elements.find(element => element?.grayTipElement?.revokeElement)?.grayTipElement.revokeElement;
          if (typeof revoke?.operatorUid === 'string' && /^u_/.test(revoke.operatorUid)) {
            this.publish({ kind: 'notice', notice: 'recall', record });
          }
        }
      } }),
      onRichMediaDownloadComplete: active(value => this.bus.emit('mediaDownload', value)),
      // Raw upload arguments stay on this internal bus. Only an active private
      // single-file send may retain a bounded, sanitized observation snapshot.
      ...Object.fromEntries(['onRichMediaProgerssUpdate', 'onRichMediaUploadComplete', 'onSendMsgError']
        .map(callback => [callback, active((...args) => this.bus.emit('fileUploadObservation', { callback, args }))])),
      onKickedOffLine: active(() => { this.online = false; this.publishState(); })
    });
    const profile = listener({
      onSelfStatusChanged: active(value => {
        if (!value || !this.self || value.uid !== this.self.uid) return;
        const statuses = [10, 11, 20, 30, 40, 50, 60, 70];
        this.online = statuses.includes(value.status) ? value.status !== 20 : null;
        this.publishState();
      }),
      onProfileDetailInfoChanged: active(value => {
        if (this.self && value?.uid === this.self.uid && typeof value.nick === 'string') {
          this.self.nickname = value.nick; this.publishState();
        }
      })
    });
    const group = listener({
      ...Object.fromEntries(Object.entries(this.social.listenerMethods.group).map(([name, method]) => [name, active(method)])),
      ...Object.fromEntries(Object.entries(this.groupQueriesApi.listenerMethods.group).map(([name, method]) => [name, active(method)])),
      onGroupListUpdate: active((kind, records) => {
        this.diagnostic(problem('GROUP_LIST_UPDATE', `type=${Number.isInteger(kind) ? kind : -1}; count=${Array.isArray(records) ? records.length : -1}`));
        if (!Array.isArray(records)) return;
        if (![0, 1, 2, 3].includes(kind)) {
          this.diagnostic(problem('UNKNOWN_GROUP_UPDATE', 'QQ group list update type is not supported'));
          return;
        }
        // Validate the whole batch before changing a complete cached list.
        const entries = records.map(record => [numeric(record?.groupCode, 'group number'), { ...record }]);
        if (kind === 0 || kind === 1) {
          this.groupList = [...new Map(entries).values()];
          this.bus.emit('groups', this.groupList);
          return;
        }
        // MODIFIED/REMOVE are deltas, not complete results. In particular,
        // an empty delta cannot initialize the cache or satisfy a query.
        if (this.groupList === null) return;
        const current = new Map(this.groupList.map(record => [String(record.groupCode), record]));
        for (const [code, record] of entries) {
          if (kind === 2) current.set(code, { ...current.get(code), ...record });
          else current.delete(code);
        }
        this.groupList = [...current.values()];
      }),
      onGroupDetailInfoChange: active(value => this.bus.emit('groupInfo', value)),
      onMemberInfoChange: active((groupId, source, records) => this.bus.emit('groupMember', String(groupId), source, records))
    });
    const buddy = listener(Object.fromEntries(Object.entries(this.social.listenerMethods.buddy).map(([name, method]) => [name, active(method)])));
    for (const [name, object, add, remove] of [
      ['msg', msg, 'addKernelMsgListener', 'removeKernelMsgListener'],
      ['profile', profile, 'addKernelProfileListener', 'removeKernelProfileListener'],
      ['group', group, 'addKernelGroupListener', 'removeKernelGroupListener'],
      ['buddy', buddy, 'addKernelBuddyListener', 'removeKernelBuddyListener']
    ]) {
      if (this.registrations.some(item => item.name === name)) continue;
      try {
        const service = this.service(name);
        if (typeof service[add] !== 'function') throw problem('UNSUPPORTED', `QQ lacks ${add}`);
        const id = Reflect.apply(service[add], service, [object]);
        this.registrations.push({ name, service, remove, id, object });
      } catch (error) { this.diagnostic(error); }
    }
  }
  retryObservers() {
    const complete = () => ['msg', 'profile', 'group', ...(typeof this.session?.getBuddyService === 'function' ? ['buddy'] : [])]
      .every(name => this.registrations.some(item => item.name === name));
    if (this.closed || !this.ready || this.runtimeProfile().admission === 'denied' || this.observerTimer || complete()) return;
    this.observerTimer = setInterval(() => {
      if (this.closed || !this.ready) { clearInterval(this.observerTimer); this.observerTimer = null; return; }
      const count = this.registrations.length;
      this.attach();
      if (this.registrations.length !== count) this.publishState();
      if (complete()) { clearInterval(this.observerTimer); this.observerTimer = null; }
    }, 200);
    this.observerTimer.unref?.();
  }
  detach() {
    this.social.clearUnread();
    // Native QQ can retain a callback even after removing its registration.
    // A failed initialization followed by recovery may reuse the same epoch;
    // retired listeners must not become active again when ready returns.
    this.observerGeneration++;
    for (const { service, remove, id } of this.registrations.splice(0)) {
      try { if (typeof service[remove] === 'function') service[remove](id); } catch (error) { this.diagnostic(error); }
    }
  }
  rejectPending(error) { for (const reject of [...this.pending]) reject(error); }

  deadline(operation, context = {}, timeoutMs = 10000) {
    if (context.signal?.aborted) return Promise.reject(problem('EXPIRED', 'Request was cancelled'));
    const startedAt = Date.now();
    const endsAt = Math.min(startedAt + timeoutMs, context.expiresAt ?? Infinity);
    const wait = endsAt - startedAt;
    if (wait <= 0) return Promise.reject(problem('EXPIRED', 'Request deadline expired'));
    const epoch = this.epoch;
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const cancel = () => finish(problem('EXPIRED', 'Request cancelled; delivery may be unknown'));
      const finish = (error, value) => {
        if (done) return;
        if (!error && Date.now() >= endsAt) error = problem('TIMEOUT', 'QQ request completed after its deadline; delivery may be unknown');
        done = true; clearTimeout(timer); this.pending.delete(rejectPending);
        context.signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const rejectPending = error => finish(error);
      const checkTimeout = () => {
        if (done) return;
        // Native timers may wake just before the wall-clock deadline. Do not
        // reject while an inner operation can still regard its context as live.
        const remaining = endsAt - Date.now();
        if (remaining > 0) { timer = setTimeout(checkTimeout, Math.max(1, Math.ceil(remaining))); return; }
        finish(problem('TIMEOUT', 'QQ request timed out; delivery may be unknown'));
      };
      timer = setTimeout(checkTimeout, Math.max(1, Math.ceil(wait)));
      this.pending.add(rejectPending);
      context.signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve().then(() => {
        if (done || this.epoch !== epoch || Date.now() >= endsAt) throw problem('EXPIRED', 'Request is no longer active');
        return operation();
      }).then(value => finish(this.epoch !== epoch
        ? problem('SESSION_CHANGED', 'QQ session changed') : null, value), finish);
    });
  }

  async waiting(event, match, request, context, allowVoid = false, timeoutMs = 10000) {
    let handler, dispatched = false;
    const response = new Promise((resolve, reject) => {
      handler = (...args) => {
        if (!dispatched) return;
        try { const value = match(...args); if (value !== undefined) resolve(value); } catch (error) { reject(error); }
      };
      this.bus.on(event, handler);
    });
    response.catch(() => {});
    try {
      return await this.deadline(async () => {
        // Keep observation installed for synchronous native callbacks, but do
        // not let an older update before this dispatch satisfy the operation.
        dispatched = true;
        const result = await request();
        if (!allowVoid || result !== undefined) confirmed(result);
        return response;
      }, context, timeoutMs);
    } finally { this.bus.removeListener(event, handler); }
  }
  async coalesce(key, operation, context = {}) {
    let query = this.queries.get(key);
    if (!query || query.controller.signal.aborted) {
      const controller = new AbortController();
      const scope = { signal: controller.signal, expiresAt: Date.now() + 10000 };
      query = { controller, waiters: 0, task: Promise.resolve().then(() => operation(scope)) };
      this.queries.set(key, query);
      const current = query;
      const retire = () => { if (this.queries.get(key) === current) this.queries.delete(key); };
      query.task.then(retire, retire);
    }
    query.waiters++;
    try {
      // A cancelled UI/OneBot request must not cancel another caller sharing
      // the same native query. Only the final waiter retires its observation.
      return await this.deadline(() => query.task, context);
    } finally {
      query.waiters--;
      if (query.waiters === 0) {
        if (this.queries.get(key) === query) this.queries.delete(key);
        query.controller.abort();
      }
    }
  }
  remember(uin, uid) {
    uin = String(uin ?? ''); uid = String(uid ?? '');
    if (!/^[1-9]\d*$/.test(uin) || !Number.isSafeInteger(Number(uin)) || !/^u_[A-Za-z0-9_-]+$/.test(uid)) return;
    const oldUid = this.forward.get(uin), oldUin = this.reverse.get(uid);
    if (oldUid && this.reverse.get(oldUid) === uin) this.reverse.delete(oldUid);
    if (oldUin && this.forward.get(oldUin) === uid) this.forward.delete(oldUin);
    this.forward.delete(uin); this.reverse.delete(uid);
    this.forward.set(uin, uid); this.reverse.set(uid, uin);
    // Busy groups can expose an unbounded stream of senders over a long-lived
    // session. Eviction affects only this lookup cache, never message IDs.
    while (this.forward.size > MAX_IDENTITIES) {
      const oldest = this.forward.keys().next().value, previous = this.forward.get(oldest);
      this.forward.delete(oldest);
      if (this.reverse.get(previous) === oldest) this.reverse.delete(previous);
    }
  }
  async resolve(params) {
    const epoch = this.epoch;
    let uin = params.uin === undefined ? null : numeric(params.uin);
    let uid = params.uid === undefined ? null : ntuid(params.uid);
    if (!uin && !uid) throw problem('INVALID_PARAMS', 'Expected uin or uid');
    if (uin && uid) {
      const knownUid = this.forward.get(uin), knownUin = this.reverse.get(uid);
      if ((knownUid && knownUid !== uid) || (knownUin && knownUin !== uin)) throw problem('INVALID_PARAMS', 'Conflicting UIN and UID');
      if (knownUid === uid && knownUin === uin) { this.remember(uin, uid); return { uin, uid }; }
      // Supplying two identifiers is not evidence that they identify the same
      // QQ account. Confirm the pair through the normal native lookup first.
      const verified = await this.resolve({ uin });
      if (verified.uid !== uid) throw problem('INVALID_PARAMS', 'Conflicting UIN and UID');
      return verified;
    }
    if (uin) uid = this.forward.get(uin); else uin = this.reverse.get(uid);
    if (!uid) {
      if (this.hasMethods('profile', ['getUidByUin'])) uid = mapValue(this.invoke('profile', 'getUidByUin', ['FriendsServiceImpl', [uin]]), uin);
      if (!uid && this.hasMethods('group', ['getUidByUins'])) uid = mapValue((await this.invoke('group', 'getUidByUins', [[uin]]))?.uids, uin);
    }
    if (!uin) {
      if (this.hasMethods('profile', ['getUinByUid'])) uin = mapValue(this.invoke('profile', 'getUinByUid', ['FriendsServiceImpl', [uid]]), uid);
      if (!uin && this.hasMethods('group', ['getUinByUids'])) uin = mapValue((await this.invoke('group', 'getUinByUids', [[uid]]))?.uins, uid);
    }
    if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ session changed');
    if (!uin || !uid) throw problem('NOT_FOUND', 'QQ could not resolve UIN/UID');
    this.remember(uin, uid);
    return { uin: numeric(uin), uid: ntuid(uid) };
  }
  simpleUser(record, fallback) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw problem('INVALID_RESPONSE', 'QQ returned no user');
    const core = record.coreInfo || record;
    const base = record.baseInfo || {};
    if ([core, base].some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
      throw problem('INVALID_RESPONSE', 'QQ returned an invalid user profile');
    }
    const uin = numeric(record.uin || core.uin || fallback?.uin);
    const uid = record.uid || core.uid || fallback?.uid;
    if ((fallback?.uin && uin !== fallback.uin) || (fallback?.uid && uid !== fallback.uid)) {
      throw problem('INVALID_RESPONSE', 'QQ user identity does not match the request');
    }
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(uid)) throw problem('INVALID_RESPONSE', 'QQ user has no exact UID');
    const masked = value => fallback?.uid === uid && typeof value === 'string' && /^u_\*+_[1-9]\d*$/.test(value) &&
      value.slice(value.lastIndexOf('_') + 1) === uin;
    if ([record, core, base].some(value => (value.uin !== undefined && String(value.uin) !== uin) ||
      (value.uid !== undefined && value.uid !== uid && !masked(value.uid)))) {
      throw problem('INVALID_RESPONSE', 'QQ nested user profile belongs to another account');
    }
    this.remember(uin, uid);
    const output = { user_id: Number(uin), uid, nickname: String(core.nick || ''), remark: String(core.remark || ''),
      sex: sex(base.sex), ...(Number.isInteger(base.age) && base.age >= 0 ? { age: base.age } : {}) };
    const strings = { qid: 'qid', longNick: 'signature', eMail: 'email', phoneNum: 'phone' };
    for (const [source, target] of Object.entries(strings)) if (typeof base[source] === 'string') output[target] = base[source];
    if (Number.isInteger(base.categoryId) && base.categoryId >= 0) output.category_id = base.categoryId;
    const birthday = [base.birthday_year, base.birthday_month, base.birthday_day];
    if (birthday.every(Number.isInteger) && birthday[0] >= 1900 && birthday[0] <= 9999 &&
      birthday[1] >= 1 && birthday[1] <= 12 && birthday[2] >= 1 && birthday[2] <= 31) {
      const date = new Date(Date.UTC(birthday[0], birthday[1] - 1, birthday[2]));
      if (date.getUTCFullYear() === birthday[0] && date.getUTCMonth() === birthday[1] - 1 && date.getUTCDate() === birthday[2]) {
        output.birthday_year = birthday[0]; output.birthday_month = birthday[1]; output.birthday_day = birthday[2];
      }
    }
    const level = record.qqLevel;
    if (level && ['crownNum', 'sunNum', 'moonNum', 'starNum'].every(key => Number.isInteger(level[key]) && level[key] >= 0 && level[key] <= 100000)) {
      output.level = level.crownNum * 64 + level.sunNum * 16 + level.moonNum * 4 + level.starNum;
    }
    const flags = record.relationFlags;
    for (const [source, target] of Object.entries({ isBlock: 'is_block', isMsgDisturb: 'is_msg_disturb',
      isSpecialCareOpen: 'is_special_care', isSpecialCareZone: 'is_special_care_zone' })) {
      if (typeof flags?.[source] === 'boolean') output[target] = flags[source];
    }
    for (const [source, target] of Object.entries({ vipFlag: 'is_vip', yearVipFlag: 'is_year_vip', svipFlag: 'is_svip' })) {
      if (typeof record.vasInfo?.[source] === 'boolean') output[target] = record.vasInfo[source];
    }
    if (Number.isInteger(record.vasInfo?.vipLevel) && record.vasInfo.vipLevel >= 0) output.vip_level = record.vasInfo.vipLevel;
    return { ...output, ...userFields(record) };
  }
  async user(params, context = {}) {
    const epoch = this.epoch;
    const current = () => {
      if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed while querying user details');
      if (context.signal?.aborted || (context.expiresAt !== undefined && Date.now() >= context.expiresAt)) {
        throw problem('EXPIRED', 'User detail query is no longer active');
      }
    };
    const who = await this.resolve(params);
    current();
    if (this.hasMethods('profile', ['getUserDetailInfoByUin'])) {
      const detail = confirmed(await this.invoke('profile', 'getUserDetailInfoByUin', [who.uin])).detail;
      current();
      // This UIN query may redact the UID as u_***_<uin>. It is a profile
      // identifier only; kernel calls and caches retain the resolved real UID.
      const masked = value => typeof value === 'string' && /^u_\*+_[1-9]\d*$/.test(value) &&
        value.slice(value.lastIndexOf('_') + 1) === who.uin;
      const sameIdentity = value => value && typeof value === 'object' && !Array.isArray(value) &&
        (value.uin === undefined || String(value.uin) === who.uin) &&
        (value.uid === undefined || value.uid === who.uid || masked(value.uid));
      const simple = detail?.simpleInfo, core = simple?.coreInfo;
      if (!sameIdentity(detail) || String(detail.uin) !== who.uin ||
        !(detail.uid === who.uid || masked(detail.uid)) || !sameIdentity(simple) ||
        [core, simple.baseInfo, detail.commonExt].some(value => value != null && !sameIdentity(value))) {
        throw problem('INVALID_RESPONSE', 'QQ user detail belongs to another account');
      }
      if (!this.userDetailSchemaLogged && [detail, simple, core].some(value => masked(value?.uid))) {
        this.userDetailSchemaLogged = true;
        this.diagnostic(problem('USER_DETAIL_SCHEMA', JSON.stringify({
          detailKeys: Object.keys(detail).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort().slice(0, 40),
          detailUinMatches: String(detail.uin) === who.uin, detailUidMasked: masked(detail.uid), detailUidExact: detail.uid === who.uid,
          simpleInfoKeys: Object.keys(simple).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort().slice(0, 40),
          coreUinMatches: core?.uin !== undefined && String(core.uin) === who.uin,
          coreUidMasked: masked(core?.uid), coreUidExact: core?.uid === who.uid
        })));
      }
      const output = this.simpleUser({ ...simple, uid: who.uid, uin: who.uin,
        qqLevel: detail.commonExt?.qqLevel || simple.qqLevel }, who);
      const ext = detail.commonExt;
      for (const [source, target] of Object.entries({ homeTown: 'hometown', pos: 'position', college: 'school',
        country: 'country', province: 'province', city: 'city', interest: 'interest', postCode: 'post_code', address: 'address' })) {
        if (typeof ext?.[source] === 'string') output[target] = ext[source];
      }
      for (const [source, target] of Object.entries({ constellation: 'constellation', shengXiao: 'zodiac',
        kBloodType: 'blood_type', makeFriendCareer: 'career', regTime: 'registration_time' })) {
        if (Number.isSafeInteger(ext?.[source]) && ext[source] >= 0) output[target] = ext[source];
      }
      if (Array.isArray(ext?.labels) && ext.labels.length <= 100 && ext.labels.every(label => typeof label === 'string')) output.labels = [...ext.labels];
      return output;
    }
    const records = await this.invoke('profile', 'getCoreAndBaseInfo', ['nodeStore', [who.uid]]);
    current();
    return this.simpleUser(mapValue(records, who.uid), who);
  }
  async friends(_params = {}, context = {}) {
    const epoch = this.epoch;
    const current = () => {
      if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed while querying friends');
      if (context.signal?.aborted || (context.expiresAt !== undefined && Date.now() >= context.expiresAt)) {
        throw problem('EXPIRED', 'Friend query is no longer active');
      }
    };
    const result = confirmed(await this.invoke('buddy', 'getBuddyListV2', ['0', true, 0]));
    current();
    if (!Array.isArray(result.data) || result.data.some(item => !item || typeof item !== 'object' || !Array.isArray(item.buddyUids) ||
      item.buddyUids.some(uid => typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(uid)))) {
      throw problem('INVALID_RESPONSE', 'QQ buddy list has an unknown shape');
    }
    const uids = [...new Set(result.data.flatMap(item => item.buddyUids))];
    if (uids.length > 10000) throw problem('INVALID_RESPONSE', 'QQ buddy list exceeds the supported account limit');
    if (!uids.length) return [];
    const values = await this.invoke('profile', 'getCoreAndBaseInfo', ['nodeStore', uids]);
    current();
    if (!(values instanceof Map) || uids.some(uid => !values.has(uid))) throw problem('INVALID_RESPONSE', 'QQ buddy details are incomplete');
    // Build category membership once. Re-scanning every category UID array for
    // each friend becomes quadratic on accounts with large contact lists.
    const memberships = new Map();
    for (const category of result.data) {
      if (!Number.isInteger(category.categoryId) || category.categoryId < 0) continue;
      const detail = { id: category.categoryId, ...(typeof category.categroyName === 'string' ? { name: category.categroyName } :
        typeof category.categoryName === 'string' ? { name: category.categoryName } : {}) };
      for (const uid of new Set(category.buddyUids)) {
        if (!memberships.has(uid)) memberships.set(uid, []);
        memberships.get(uid).push(detail);
      }
    }
    return uids.map(uid => {
      const value = this.simpleUser(values.get(uid), { uid });
      const categories = (memberships.get(uid) || []).map(category => ({ ...category }));
      if (categories.length) value.categories = categories;
      const category = categories.find(item => item.id === value.category_id);
      if (category?.name !== undefined) value.category_name = category.name;
      return value;
    });
  }
  normalizeGroup(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.groupName !== 'string') {
      throw problem('INVALID_RESPONSE', 'QQ returned no valid group');
    }
    return { group_id: Number(numeric(record.groupCode, 'group number')), group_name: record.groupName, ...groupFields(record) };
  }
  async groups(params, context) {
    if (this.groupList !== null && !params.refresh) return this.groupList.map(record => this.normalizeGroup(record));
    // Before observing a full snapshot, ask QQ to refresh rather than treating
    // an uninitialized local table as a complete empty account membership.
    const force = Boolean(params.refresh) || this.groupList === null;
    const list = await this.coalesce('groups', scope => this.waiting('groups', records => records,
      async () => {
        const result = await this.invoke('group', 'getGroupList', [force]);
        this.diagnostic(problem('GROUP_LIST_REQUEST', `force=${Number(force)}; result=${Number.isInteger(result?.result) ? result.result : -1}`));
        return result;
      }, scope), context);
    return list.map(record => this.normalizeGroup(record));
  }
  async groupInfo(params, context) {
    const groupId = numeric(params.groupId, 'group number');
    const detail = await this.coalesce(`group:${groupId}`, scope => this.waiting('groupInfo',
      record => String(record?.groupCode) === groupId ? record : undefined,
      () => this.invoke('group', 'getGroupDetailInfo', [groupId, 2]), scope), context);
    return this.normalizeGroup(detail);
  }
  async groupMember(params, context) {
    const groupId = numeric(params.groupId, 'group number');
    const who = await this.resolve({ uin: params.uin });
    const record = await this.coalesce(`member:${groupId}:${who.uid}:${Boolean(params.refresh)}`, scope => this.waiting('groupMember',
      (received, _source, records) => received === groupId ? mapValue(records, who.uid) : undefined,
      () => this.invoke('group', 'getMemberInfo', [groupId, [who.uid], Boolean(params.refresh)]), scope), context);
    return this.normalizeMember(groupId, record, who);
  }
  normalizeMember(groupId, record, fallback) {
    if (!record || typeof record !== 'object') throw problem('INVALID_RESPONSE', 'QQ returned no group member');
    const who = { uin: numeric(record.uin || fallback?.uin), uid: ntuid(record.uid || fallback?.uid) };
    if (fallback && ((record.uin && String(record.uin) !== fallback.uin) || (record.uid && record.uid !== fallback.uid))) {
      throw problem('INVALID_RESPONSE', 'QQ member identity does not match the request');
    }
    this.remember(who.uin, who.uid);
    const role = ({ 2: 'member', 3: 'admin', 4: 'owner' })[record.role];
    if (!role) throw problem('INVALID_RESPONSE', 'QQ group member role is unknown');
    return { group_id: Number(groupId), user_id: Number(who.uin), uid: who.uid, nickname: String(record.nick || ''),
      card: String(record.cardName || ''), role, sex: sex(record.sex),
      ...(Number.isInteger(record.age) && record.age >= 0 ? { age: record.age } : {}),
      join_time: profileInteger(record.joinTime) ?? 0, last_sent_time: profileInteger(record.lastSpeakTime) ?? 0,
      level: String(record.memberRealLevel ?? ''), title: String(record.memberSpecialTitle || ''),
      area: '', title_expire_time: 0, ...memberFields(record) };
  }
  async groupMembers(params, context) {
    const groupId = numeric(params.groupId, 'group number');
    const records = await this.groupMemberRecords(params, context);
    return records.map(record => this.normalizeMember(groupId, record));
  }
  async groupMemberRecords(params, context, options = {}) {
    const epoch = this.epoch;
    const groupId = numeric(params.groupId, 'group number');
    const check = () => {
      if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed while querying members');
      if (context?.signal?.aborted || context?.expiresAt !== undefined && Date.now() >= context.expiresAt) {
        throw problem('EXPIRED', 'Member query expired or was cancelled');
      }
      options.check?.();
    };
    const invoke = options.invoke || ((method, args) => this.invoke('group', method, args));
    check();
    const response = await invoke('getAllMemberList', [groupId, Boolean(params.refresh)]);
    check();
    if (!response || response.errCode !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the member list query');
    const result = response.result;
    if (!result || result.finish !== true || !(result.infos instanceof Map) || !Array.isArray(result.ids) ||
        result.ids.length > 10000 || result.infos.size > result.ids.length) {
      throw problem('INVALID_RESPONSE', 'QQ returned an incomplete member list');
    }
    const ids = result.ids.map(value => ntuid(typeof value === 'string' ? value : value?.uid));
    const wanted = new Set(ids);
    if (wanted.size !== ids.length) {
      throw problem('INVALID_RESPONSE', 'QQ member identities and records are inconsistent');
    }
    for (const uid of result.infos.keys()) if (!wanted.has(uid)) {
      throw problem('INVALID_RESPONSE', 'QQ member identities and records are inconsistent');
    }
    const records = new Map();
    const merge = (uid, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.uid !== undefined && value.uid !== uid)) throw problem('INVALID_RESPONSE', 'QQ returned a mismatched group member');
      if (options.requireMuteState === true) {
        // Native members contain Maps, wide integers and other opaque data.
        // Read only the fixed mute-query fields, including during hydration;
        // enumerating the native object could invoke unrelated getters.
        const selected = {};
        for (const name of ['uid', 'uin', 'nick', 'shutUpTime', 'role', 'cardName', 'groupCode']) {
          const field = value[name];
          if (field !== undefined) selected[name] = field;
        }
        value = selected;
      }
      const previous = records.get(uid);
      if (previous?.uin && value.uin && String(previous.uin) !== String(value.uin)) throw problem('INVALID_RESPONSE', 'QQ member UIN changed inside one snapshot');
      records.set(uid, { ...previous, ...value, uid });
    };
    for (let index = 0; index < ids.length; index++) {
      const uid = ids[index], value = result.ids[index];
      merge(uid, typeof value === 'string' ? { uid } : value);
      if (result.infos.has(uid)) merge(uid, result.infos.get(uid));
    }
    const missing = ids.filter(uid => {
      const record = records.get(uid);
      return !record.uin || ![2, 3, 4].includes(record.role) || options.requireMuteState === true &&
        (record.nick === undefined || record.shutUpTime === undefined);
    });
    if (missing.length && !this.hasMethods('group', ['getMemberInfo'])) throw problem('UNSUPPORTED', 'QQ cannot complete the member list details');
    // Some QQ builds return a complete identity list but an empty detail Map.
    // Fetch actual records in bounded batches; never invent members from UIDs.
    for (let offset = 0; offset < missing.length; offset += 50) {
      check();
      const batch = missing.slice(offset, offset + 50), pending = new Set(batch);
      await this.waiting('groupMember', (received, _source, values) => {
        if (received !== groupId || !(values instanceof Map)) return undefined;
        for (const uid of batch) if (values.has(uid)) { merge(uid, values.get(uid)); pending.delete(uid); }
        return pending.size === 0 ? true : undefined;
      }, () => { check(); return invoke('getMemberInfo', [groupId, batch, Boolean(params.refresh)]); }, context);
    }
    check();
    // Validate the complete result before normalizeMember updates UID caches.
    for (const uid of ids) {
      const record = records.get(uid);
      numeric(record.uin, 'member QQ number'); ntuid(record.uid);
      if (![2, 3, 4].includes(record.role)) throw problem('INVALID_RESPONSE', 'QQ group member role is unknown');
    }
    return ids.map(uid => records.get(uid));
  }
  async history(params) {
    const peer = plainPeer(params.peer);
    const nativeId = params.nativeId ?? '0';
    const count = params.count ?? 20;
    if (typeof nativeId !== 'string' || !/^\d+$/.test(nativeId) || !Number.isInteger(count) || count < 1 || count > 101 ||
      (params.reverse !== undefined && typeof params.reverse !== 'boolean')) throw problem('INVALID_PARAMS', 'Invalid history cursor or count');
    const result = confirmed(await (nativeId === '0'
      ? this.invoke('msg', 'getAioFirstViewLatestMsgs', [peer, count])
      : this.invoke('msg', 'getMsgsIncludeSelf', [peer, nativeId, count, params.reverse === true])));
    if (!Array.isArray(result.msgList) || result.msgList.length > count || result.msgList.some(record =>
      record?.chatType !== peer.chatType || record.peerUid !== peer.peerUid || typeof record.msgId !== 'string' || !record.msgId)) {
      throw problem('INVALID_RESPONSE', 'QQ returned invalid history for this conversation');
    }
    if (new Set(result.msgList.map(record => record.msgId)).size !== result.msgList.length) {
      throw problem('INVALID_RESPONSE', 'QQ history contains duplicate native messages');
    }
    return { records: result.msgList };
  }
  async recall(params, context) {
    const epoch = this.epoch;
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Recall is not bound to the current QQ session');
    const peer = plainPeer(params.peer);
    if (typeof params.nativeId !== 'string' || !/^[1-9]\d*$/.test(params.nativeId)) throw problem('INVALID_PARAMS', 'Invalid recall message ID');
    await this.waiting('sent', records => records.find(record => record?.chatType === peer.chatType &&
      record.peerUid === peer.peerUid && record.msgId === params.nativeId && Number(record.recallTime) > 0),
    () => this.invoke('msg', 'recallMsg', [peer, [params.nativeId]]), context);
    if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ session changed while recalling');
    return { recalled: true };
  }
  async prepareMedia(params, context) {
    const epoch = this.epoch;
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Media preparation is not bound to this QQ session');
    if (!['image', 'file', 'record', 'video'].includes(params.type)) throw problem('UNSUPPORTED', 'This media type has no implemented native preparation');
    if (params.summary !== undefined && (typeof params.summary !== 'string' || Buffer.byteLength(params.summary) > 1024)) {
      throw problem('INVALID_PARAMS', 'Invalid image summary');
    }
    const image = params.type === 'image' ? media.readImage(this.mediaDirectory, params.file) : params.type === 'record'
      ? await this.audio.prepare(params.file, context) : params.type === 'video' ? await this.video.prepare(params.file, context) : media.readLocal(this.mediaDirectory, params.file);
    const name = params.name ?? image.filename;
    if (params.type === 'file' && (typeof name !== 'string' || !name.trim() || ['.', '..'].includes(name) || /[\\/\x00-\x1f\x7f-\x9f]/.test(name) || Buffer.byteLength(name) > 255)) throw problem('INVALID_PARAMS', 'Invalid upload filename');
    if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'Media preparation was cancelled');
    const elementType = params.type === 'image' ? 2 : params.type === 'record' ? 4 : params.type === 'video' ? 5 : 3;
    const fileName = image.md5 + (params.type === 'image' ? '.' + image.extension : params.type === 'record' ? '.silk' : params.type === 'video' ? '.mp4' : '.bin');
    const filename = await this.invoke('msg', 'getRichMediaFilePathForGuild', [{ md5HexStr: image.md5,
      fileName, elementType, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' }]);
    if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed during media preparation');
    const sourcePath = media.copyToNative(filename, this.mediaTargetRoots, image.bytes);
    let videoDetails;
    if (params.type === 'video') {
      const fs = require('node:fs');
      const thumb = image.thumbnail;
      if (!thumb || !Buffer.isBuffer(thumb.bytes) || thumb.bytes.length < 1 || thumb.extension !== 'png') throw problem('INVALID_RESPONSE', 'Video has no real decoded PNG thumbnail');
      // The direct kernel video contract uses a PNG in the native Thumb
      // sibling of Ori. Other layouts have not been verified for this QQ.
      const originalDirectory = path.dirname(sourcePath);
      if (path.basename(originalDirectory) !== 'Ori') throw problem('UNSUPPORTED', 'QQ returned an unverified video cache layout');
      const thumbnailDirectory = path.join(path.dirname(originalDirectory), 'Thumb');
      try { fs.mkdirSync(thumbnailDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const thumbnailStat = fs.lstatSync(thumbnailDirectory);
      if (!thumbnailStat.isDirectory() || thumbnailStat.isSymbolicLink() || fs.realpathSync(thumbnailDirectory) !== thumbnailDirectory ||
          (process.platform !== 'win32' && thumbnailStat.uid !== process.getuid())) throw problem('INVALID_RESPONSE', 'QQ video thumbnail directory is not owned and canonical');
      const thumbPath = media.copyToNative(path.join(thumbnailDirectory, image.md5 + '_0.png'), this.mediaTargetRoots, thumb.bytes);
      videoDetails = { fileName, filePath: sourcePath, videoMd5: image.md5, thumbMd5: thumb.md5,
        fileTime: image.durationSeconds, fileSize: String(image.bytes.length),
        thumbWidth: thumb.width, thumbHeight: thumb.height,
        thumbSize: thumb.bytes.length, thumbPath: { 0: thumbPath } };
    }
    this.preparedMedia.delete(sourcePath);
    this.preparedMedia.set(sourcePath, { epoch, type: params.type, md5: image.md5, size: image.bytes.length, at: Date.now(),
      ...(params.type === 'record' ? { duration: Math.ceil(image.durationSeconds), waveAmplitudes: [...image.waveAmplitudes] } : {}) });
    if (videoDetails) {
      const prepared = this.preparedMedia.get(sourcePath);
      prepared.video = JSON.parse(JSON.stringify(videoDetails));
      prepared.metadata = { width: image.width, height: image.height, durationSeconds: image.durationSeconds, fileFormat: image.fileFormat };
      prepared.thumbnail = { md5: image.thumbnail.md5, size: image.thumbnail.bytes.length };
    }
    while (this.preparedMedia.size > 1000) this.preparedMedia.delete(this.preparedMedia.keys().next().value);
    if (params.type === 'file') return { elementType, elementId: '', fileElement: {
      fileName: name, folderId: '', filePath: sourcePath, fileSize: String(image.bytes.length) } };
    if (videoDetails) return { elementType, elementId: '', videoElement: videoDetails };
    if (params.type === 'record') return { elementType, elementId: '', pttElement: {
      fileName, filePath: sourcePath, md5HexStr: image.md5, fileSize: String(image.bytes.length), duration: Math.ceil(image.durationSeconds),
      formatType: 1, voiceType: 1, voiceChangeType: 0, canConvert2Text: false, waveAmplitudes: [...image.waveAmplitudes],
      fileSubId: '', playState: 1, autoConvertText: 0, storeID: 0, otherBusinessInfo: { aiVoiceType: 0 } } };
    return { elementType, elementId: '', picElement: { md5HexStr: image.md5, fileSize: String(image.bytes.length),
      picWidth: image.width, picHeight: image.height, fileName, sourcePath, original: true, picType: image.picType,
      picSubType: 0, fileUuid: '', fileSubId: '', thumbFileSize: 0, summary: params.summary || '' } };
  }
  async imageInfo(params) { return media.resourceInfo(this.mediaDirectory, params.file); }
  async nativeRkey(params, context = {}) {
    this.ensureReady();
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) {
      throw problem('SESSION_CHANGED', 'Native rkey query must be bound to the current QQ session');
    }
    const epoch = this.epoch, deadline = Date.now() + (params.timeoutMs ?? 10000);
    if (params.via !== undefined && !['native', 'js'].includes(params.via)) throw problem('INVALID_PARAMS', 'Invalid rkey transport');
    if (params.via !== 'js') {
      try {
        return await require('./msf-native.cjs').run(this, { op: 'fetchRkey', timeoutMs: params.timeoutMs, expectedEpoch: params.expectedEpoch, expectedUin: params.expectedUin, signal: context.signal });
      } catch (error) {
        if (params.via === 'native' || ['SESSION_CHANGED', 'TIMEOUT', 'EXPIRED'].includes(error.code) || context.signal?.aborted) throw error;
        // fall back to the JS SSO channel when the native path is unavailable
      }
    }
    const remaining = deadline - Date.now();
    if (remaining < 1 || context.signal?.aborted) throw problem('TIMEOUT', 'Native rkey query exceeded its total deadline');
    const result = await require('./rkey.cjs').fetchRkeys(this, { ...params, timeoutMs: remaining });
    if (this.epoch !== epoch || context.signal?.aborted) throw problem('SESSION_CHANGED', 'QQ changed during rkey lookup');
    return result;
  }
  async nativeStatus(params) {
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) throw problem('SESSION_CHANGED', 'Native status belongs to another QQ session');
    return require('./msf-native.cjs').status();
  }
  async packetStatus(params) {
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) throw problem('SESSION_CHANGED', 'Packet status belongs to another QQ session');
    return require('./msf-native.cjs').packetStatus();
  }
  async authQuery(params, context = {}) { return this.authExtraApi.query(params, context); }
  async modelShow(params, context = {}) { return this.modelShowApi.execute(params, context); }
  async urlSafetyQuery(params, context = {}) { return this.urlSafetyApi.query(params, context); }
  async urlSafetyNativeQuery(params, context = {}) { return this.urlSafetyApi.nativeQuery(params, context); }
  async collectionCreate(params, context = {}) { return this.collectionCreateApi.action(params, context); }
  async emojiSummaryQuery(params, context = {}) { return this.emojiSummaryApi.query(params, context); }
  async anonymousAction(params, context = {}) { return this.anonymousApi.execute(params, context); }
  async rawPacket(params, context = {}) {
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) throw problem('SESSION_CHANGED', 'Raw packet must be bound to the current QQ session');
    return require('./msf-native.cjs').run(this, { ...params, op: 'rawPacket', signal: context.signal,
      timeoutMs: Math.min(params.timeoutMs ?? 10000, Math.max(1, (context.expiresAt ?? Date.now() + 10000) - Date.now())) });
  }
  async nativePrivateFileUrl(params, context = {}) {
    const epoch = this.epoch;
    if (params.expectedEpoch !== epoch || String(params.expectedUin) !== String(this.self?.uin)) throw problem('SESSION_CHANGED', 'Private file lookup must be bound to the QQ session');
    if (params.diagnostic !== undefined && (params.diagnostic !== 'resource-metadata' || params.transport !== undefined && params.transport !== 'oidb')) {
      throw problem('INVALID_PARAMS', 'Private file diagnostics require the fixed OIDB query');
    }
    const privateFiles = require('./private-file-url.cjs');
    // Older internal diagnostics omit both fields; a supplied binding is always complete.
    const expectedFile = Object.hasOwn(params, 'expectedFileId') || Object.hasOwn(params, 'expectedFileHash')
      ? privateFiles.fromFileElement({ fileUuid: params.expectedFileId, file10MMd5: params.expectedFileHash }) : null;
    const peer = plainPeer(params.peer);
    if (peer.chatType !== 1 || typeof params.elementId !== 'string' || !params.elementId) throw problem('INVALID_PARAMS', 'Private file lookup requires an exact private message element');
    const record = await this.getMessage({ peer, nativeId: params.nativeId });
    if (this.epoch !== epoch || context.signal?.aborted) throw problem('SESSION_CHANGED', 'QQ changed while locating the private file');
    const matches = record.elements?.filter(item => item?.elementType === 3 && item.elementId === params.elementId) || [];
    if (matches.length !== 1) throw problem('NOT_FOUND', 'QQ returned no unique matching private file');
    const file = privateFiles.fromFileElement(matches[0].fileElement);
    if (expectedFile && (file.fileId !== expectedFile.fileId || file.fileHash !== expectedFile.fileHash)) {
      throw problem('INVALID_RESPONSE', 'QQ private file does not match the expected resource');
    }
    return require('./msf-native.cjs').run(this, { op: 'fetchPrivateFileUrl', ...file,
      transport: params.transport, diagnostic: params.diagnostic, expectedEpoch: epoch, expectedUin: this.self.uin, signal: context.signal,
      timeoutMs: Math.min(params.timeoutMs ?? 10000, Math.max(1, (context.expiresAt ?? Date.now() + 10000) - Date.now())) });
  }
  async nativeGroupFileUrl(params, context = {}) {
    this.ensureReady();
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) {
      throw problem('SESSION_CHANGED', 'Native group-file URL query must be bound to the current QQ session');
    }
    return require('./msf-native.cjs').run(this, { op: 'fetchGroupFileUrl', groupId: params.groupId,
      fileId: params.fileId, busId: params.busId, fileName: params.fileName, timeoutMs: params.timeoutMs, expectedEpoch: params.expectedEpoch, expectedUin: params.expectedUin, signal: context.signal });
  }
  async nativeGroupFileSpace(params, context = {}) {
    this.ensureReady();
    if (params.expectedEpoch !== this.epoch || String(params.expectedUin) !== String(this.self?.uin)) {
      throw problem('SESSION_CHANGED', 'Native group-file space query must be bound to the current QQ session');
    }
    return require('./msf-native.cjs').run(this, { op: 'fetchGroupFileSpace', groupId: params.groupId, timeoutMs: params.timeoutMs, expectedEpoch: params.expectedEpoch, expectedUin: params.expectedUin, signal: context.signal });
  }
  async socialQuery(params, context) { return this.social.query(params, context); }
  async extendedQuery(params, context) { return this.extendedApi.query(params, context); }
  async groupQuery(params, context) { return this.groupQueriesApi.dispatch(params.operation, params, context); }
  async collectionQuery(params, context) { return this.collectionQueries.query(params, context); }
  async extendedQuery2(params, context) { return this.extendedQueries2Api.query(params, context); }
  async shareQuery(params, context) { return this.shareQueriesApi.query(params, context); }
  async adminQuery(params, context) { return this.adminQueriesApi.query(params, context); }
  async adminAction(params, context) { return this.adminQueriesApi.action(params, context); }
  async customFaceQuery(params, context) { return this.customFaceApi.query(params, context); }
  async customFaceAction(params, context) { return this.customFaceApi.action(params, context); }
  async contactExtra(params, context) { return this.contactExtraApi.execute(params, context); }
  async flashTransfer(params, context) { return this.flashTransferApi.execute(params, context); }
  async qzoneQuery(params, context) { return this.qzoneApi.query(params, context); }
  async friendDressQuery(params, context) { return this.friendDressApi.query(params, context); }
  async forwardUpload(params, context) { return this.forwardUploadApi.upload(params, context); }
  async voiceExtra(params, context) { return this.voiceExtraApi.execute(params, context); }
  async qzoneAction(params, context) { return this.qzoneApi.action(params, context); }
  async groupAlbumQuery(params, context) { return this.groupAlbumApi.query(params, context); }
  async groupAlbumAction(params, context) { return this.groupAlbumApi.action(params, context); }
  async miscExtra(params, context) { return this.miscExtraApi.execute(params, context); }
  async accountQuery(params, context) { return this.accountQueriesApi.query(params, context); }
  async extendedAction(params, context) { return this.extendedApi.action(params, context); }
  async recordExport(params, context) { this.ensureReady(); return this.recordExporter.export(params, context); }
  async interaction(params, context) {
    const { operation, ...input } = params;
    return this.interactions.dispatch(operation, input, context);
  }
  async groupFiles(params, context) {
    const { operation, ...input } = params;
    return this.groupFilesApi.dispatch(operation, input, context);
  }
  async forwardOperation(params, context) {
    if (params.expectedEpoch !== this.epoch) throw problem('SESSION_CHANGED', 'Forward operation must be bound to the current QQ session');
    if (params.kind === 'customMerge') return this.mergedSendApi.run(params, context);
    if (params.kind === 'customResourceMerge') return this.customMergedResourceApi.run(params, context);
    return this.forwardApi.run(params, context);
  }
  async socialAction(params, context) { return this.social.action(params, context); }
  async receiveMedia(params, context) {
    const epoch = this.epoch;
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Media receipt is not bound to this QQ session');
    if (typeof params.elementId !== 'string' || !params.elementId || params.elementId.length > 200) throw problem('INVALID_PARAMS', 'Image has no exact kernel element ID');
    const peer = plainPeer(params.peer);
    const record = await this.getMessage({ peer, nativeId: params.nativeId });
    if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed while locating received image');
    if (!Array.isArray(record.elements)) throw problem('INVALID_RESPONSE', 'QQ image message has no element list');
    const matches = record.elements.filter(item => [2, 4, 5].includes(item?.elementType) && item.elementId === params.elementId);
    if (matches.length > 1) throw problem('INVALID_RESPONSE', 'QQ returned ambiguous image element identities');
    const element = matches[0];
    const type = ({ 2: 'image', 4: 'record', 5: 'video' })[element?.elementType];
    const details = element?.picElement || element?.pttElement || element?.videoElement;
    if (!type || !details) throw problem('NOT_FOUND', 'QQ did not return the requested media element');
    const key = JSON.stringify([peer.chatType, peer.peerUid, params.nativeId, params.elementId]);
    const cached = this.receivedMedia.get(key);
    if (cached) {
      try {
        const info = media.resourceInfo(this.mediaDirectory, cached), digest = type === 'video' ? details.videoMd5 : details.md5HexStr;
        if (info.type !== type || details.fileSize !== undefined && String(details.fileSize) !== String(info.size) ||
          typeof digest === 'string' && /^[a-fA-F0-9]{32}$/.test(digest) && info.md5 !== digest.toLowerCase()) {
          throw problem('INVALID_RESPONSE', 'Cached media no longer matches this message element');
        }
        return info;
      } catch { this.receivedMedia.delete(key); }
    }
    let image;
    for (const filename of [details.sourcePath, details.originImagePath, details.filePath]) {
      if (typeof filename !== 'string' || !filename) continue;
      try { image = media.readNativeMedia(type, filename, this.mediaTargetRoots); break; }
      catch (error) { if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error; }
    }
    if (!image && type === 'video') {
      // Video sources come straight from the native MSF NTV2RichMedia channel;
      // the JS downloadRichMedia / getVideoPlayUrlV2 paths fail on this build.
      const native = await require('./msf-native.cjs').run(this, { op: 'fetchVideoUrl',
        fileUuid: details.fileUuid, isGroup: Number(peer.chatType) === 2, targetUid: this.self?.uid,
        expectedEpoch: epoch, expectedUin: this.self?.uin, signal: context.signal, timeoutMs: 8000 });
      if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed during native video URL lookup');
      image = await downloadVideo({ urls: [{ url: native.url }], expectedSize: details.fileSize, expectedMd5: details.videoMd5,
        signal: context.signal, expiresAt: context.expiresAt ?? Date.now() + 60000 });
    } else if (!image && this.hasMethods('msg', ['downloadRichMedia'])) {
      const completed = await this.waiting('mediaDownload', value => {
        if (value?.msgId !== params.nativeId || value.msgElementId !== params.elementId || value.chatType !== peer.chatType ||
          (value.peerUid !== undefined && value.peerUid !== peer.peerUid)) return undefined;
        if (!zeroCode(value.fileErrCode) || !zeroCode(value.fileSrvErrCode)) {
          const code = input => typeof input === 'string' && /^-?\d{1,12}$/.test(input) || Number.isSafeInteger(input)
            ? `${typeof input}:${input}` : typeof input;
          throw problem('KERNEL_ERROR', `QQ failed to download the received ${type} (file=${code(value.fileErrCode)}; server=${code(value.fileSrvErrCode)})`);
        }
        if (typeof value.filePath !== 'string' || !value.filePath) throw problem('INVALID_RESPONSE', 'QQ image download returned no local file');
        return value;
      }, async () => {
        const result = await this.invoke('msg', 'downloadRichMedia', [{ fileModelId: '0', downSourceType: 0,
          downloadSourceType: 0, triggerType: 1, msgId: params.nativeId, chatType: peer.chatType,
          peerUid: peer.peerUid, elementId: params.elementId, thumbSize: 0, downloadType: 1, filePath: '' }]);
        if ((typeof result === 'number' && !zeroCode(result)) ||
          (result && Object.hasOwn(result, 'result') && !zeroCode(result.result))) {
          throw problem('KERNEL_ERROR', 'QQ rejected the image download request');
        }
        // Invocation acceptance is not download success; the matching complete
        // event above must still confirm the real file and its error codes.
      }, context, true, 60000);
      if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed during image download');
      image = media.readNativeMedia(type, completed.filePath, this.mediaTargetRoots);
      const transferSize = completed.totalSize;
      const validSize = typeof transferSize === 'string' && /^\d+$/.test(transferSize) || Number.isSafeInteger(transferSize) && transferSize >= 0;
      if (!validSize || BigInt(transferSize) !== 0n && BigInt(transferSize) !== BigInt(image.bytes.length)) {
        this.diagnostic(problem('MEDIA_DOWNLOAD_SIZE', JSON.stringify({ type, sizeType: typeof transferSize,
          ...(validSize ? { transferSize: String(transferSize) } : {}), actualSize: image.bytes.length })));
        throw problem('INVALID_RESPONSE', 'QQ downloaded media size does not match its completed transfer');
      }
      if (BigInt(transferSize) === 0n && (!/^[1-9]\d*$/.test(String(details.fileSize || '')) ||
        BigInt(details.fileSize) !== BigInt(image.bytes.length))) throw problem('INVALID_RESPONSE', 'QQ media has no confirmed complete size');
    }
    if (!image) throw problem('NOT_FOUND', 'QQ has no complete account-local ' + type + ' and no verified download completed');
    const declaredSize = details.fileSize;
    if (declaredSize !== undefined && (!/^[1-9]\d*$/.test(String(declaredSize)) ||
      typeof declaredSize === 'number' && !Number.isSafeInteger(declaredSize) || BigInt(declaredSize) !== BigInt(image.bytes.length))) {
      throw problem('INVALID_RESPONSE', 'QQ media contents do not match their declared size');
    }
    const expectedMd5 = type === 'video' ? details.videoMd5 : details.md5HexStr;
    if (typeof expectedMd5 === 'string' && /^[a-fA-F0-9]{32}$/.test(expectedMd5) &&
      createHash('md5').update(image.bytes).digest('hex') !== expectedMd5.toLowerCase()) {
      throw problem('INVALID_RESPONSE', 'QQ received image bytes do not match the original image hash');
    }
    if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed before image receipt completed');
    const result = media.exportMedia(this.mediaDirectory, type, image);
    this.receivedMedia.set(key, result.file);
    while (this.receivedMedia.size > 1000) this.receivedMedia.delete(this.receivedMedia.keys().next().value);
    return result;
  }
  async groupAction(params, context) {
    const epoch = this.epoch;
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Group mutation is not bound to this QQ session');
    const groupId = numeric(params.groupId, 'group number');
    if (params.operation === 'kick') return kickMember(this, { ...params, groupId }, context);
    let method, args;
    switch (params.operation) {
    case 'name':
      if (typeof params.name !== 'string' || !params.name.trim() || Buffer.byteLength(params.name) > 255) throw problem('INVALID_PARAMS', 'Invalid group name');
      method = 'modifyGroupName'; args = [groupId, params.name, false]; break;
    case 'wholeBan':
      if (typeof params.enable !== 'boolean') throw problem('INVALID_PARAMS', 'enable must be boolean');
      method = 'setGroupShutUp'; args = [groupId, params.enable]; break;
    case 'memberBan': {
      if (!Number.isInteger(params.duration) || params.duration < 0 || params.duration > 2592000) throw problem('INVALID_PARAMS', 'Invalid group ban duration');
      const who = await this.resolve({ uin: params.uin });
      method = 'setMemberShutUp'; args = [groupId, [{ uid: who.uid, timeStamp: params.duration }]]; break;
    }
    case 'card': case 'admin': {
      const who = await this.resolve({ uin: params.uin });
      if (params.operation === 'card' && (typeof params.card !== 'string' || Buffer.byteLength(params.card) > 255)) throw problem('INVALID_PARAMS', 'Invalid member card');
      if (params.operation === 'admin' && typeof params.enable !== 'boolean') throw problem('INVALID_PARAMS', 'enable must be boolean');
      if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed before member mutation');
      const role = params.enable ? 3 : 2;
      const key = JSON.stringify([epoch, groupId, who.uid]);
      if (this.memberMutations.has(key)) throw problem('BUSY', 'A mutation for this group member is awaiting confirmation');
      this.memberMutations.add(key);
      try { await this.waiting('groupMember', (received, _source, records) => {
        if (received !== groupId) return undefined;
        const record = mapValue(records, who.uid);
        if (!record || record.isDelete === true || record.uid !== who.uid || String(record.uin) !== who.uin) return undefined;
        return (params.operation === 'card' ? record.cardName === params.card : record.role === role) ? record : undefined;
      }, async () => {
        // These two public methods return void. Their matching refreshed member
        // callback, rather than that return value, confirms the resulting state.
        const result = await this.invoke('group', params.operation === 'card' ? 'modifyMemberCardName' : 'modifyMemberRole',
          [groupId, who.uid, params.operation === 'card' ? params.card : role]);
        if (result !== undefined) confirmed(result);
        if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed during member mutation');
        confirmed(await this.invoke('group', 'getMemberInfo', [groupId, [who.uid], true]));
      }, context, true); }
      finally { this.memberMutations.delete(key); }
      return { confirmed: true };
    }
    case 'leave':
      method = 'quitGroupV2'; args = [{ groupCode: groupId, needDeleteLocalMsg: false }]; break;
    default: throw problem('UNSUPPORTED', 'Unsupported group mutation');
    }
    if (context.signal?.aborted || this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed before group mutation');
    confirmed(await this.invoke('group', method, args));
    if (this.epoch !== epoch) throw problem('SESSION_CHANGED', 'QQ changed while awaiting group mutation');
    return { confirmed: true };
  }
  async getMessage(params) {
    const peer = plainPeer(params.peer);
    let result;
    const byClient = !params.nativeId && !params.seq && peer.chatType === 1 &&
      typeof params.clientSeq === 'string' && /^[1-9]\d*$/.test(params.clientSeq) &&
      typeof params.time === 'string' && /^[1-9]\d*$/.test(params.time) &&
      typeof params.senderUid === 'string' && /^u_[A-Za-z0-9_-]+$/.test(params.senderUid);
    if (typeof params.nativeId === 'string' && /^\d+$/.test(params.nativeId)) {
      result = await this.invoke('msg', 'getMsgsByMsgId', [peer, [params.nativeId]]);
    } else if (typeof params.seq === 'string' && /^[1-9]\d*$/.test(params.seq)) {
      result = await this.invoke('msg', 'getSingleMsg', [peer, params.seq]);
    } else if (byClient) {
      result = await this.invoke('msg', 'getMsgByClientSeqAndTime', [peer, params.clientSeq, params.time]);
    } else throw problem('INVALID_PARAMS', 'Expected exact nativeId or positive message sequence');
    confirmed(result);
    if (!Array.isArray(result.msgList)) throw problem('INVALID_RESPONSE', 'QQ message result has an unknown shape');
    const matches = result.msgList.filter(value => value?.chatType === peer.chatType && value.peerUid === peer.peerUid &&
      (params.nativeId ? value.msgId === params.nativeId : byClient
        ? String(value.clientSeq) === params.clientSeq && String(value.msgTime) === params.time && value.senderUid === params.senderUid
        : String(value.msgSeq) === params.seq));
    if (matches.length > 1) throw problem('INVALID_RESPONSE', 'QQ returned ambiguous native message identities');
    const record = matches[0];
    if (!record) throw problem('NOT_FOUND', 'QQ message was not found in the requested conversation');
    return record;
  }
  async prepareMusic(params) {
    const peer = plainPeer(params.peer), epoch = this.epoch;
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Music preparation belongs to another QQ session');
    const card = validateMusicCard(params.card);
    const now = Date.now();
    for (const [token, prepared] of this.preparedMusic) if (now - prepared.at > 60000) this.preparedMusic.delete(token);
    if (this.preparedMusic.size >= 100) throw problem('BUSY', 'Too many prepared music cards');
    const musicToken = randomUUID();
    this.preparedMusic.set(musicToken, { peer, epoch, card, at: now });
    return { elementType: 10, elementId: '', arkElement: { bytesData: card, linkInfo: null, subElementType: null }, musicToken };
  }

  async prepareShare(params) { return this.shareCards.prepare(params); }

  verifyVideo(element, epoch) {
    const video = element?.videoElement, prepared = video && this.preparedMedia.get(video.filePath);
    if (!prepared || prepared.type !== 'video' || prepared.epoch !== epoch || Date.now() - prepared.at > 300000 ||
        !video || JSON.stringify(video) !== JSON.stringify(prepared.video)) {
      throw problem('INVALID_PARAMS', 'Video was not prepared in this account native cache');
    }
    media.verifyPrepared(video.filePath, this.mediaTargetRoots, prepared);
    media.verifyPrepared(video.thumbPath['0'], this.mediaTargetRoots, prepared.thumbnail);
  }

  async sendMessage(params, context) {
    const epoch = this.epoch;
    const selfUin = this.self?.uin;
    if (!selfUin || !this.self?.uid || params.expectedEpoch !== epoch) {
      throw problem('SESSION_CHANGED', 'Send request does not match the authenticated QQ session');
    }
    const peer = plainPeer(params.peer);
    const payloads = { 1: 'textElement', 2: 'picElement', 3: 'fileElement', 4: 'pttElement',
      5: 'videoElement', 6: 'faceElement', 7: 'replyElement', 10: 'arkElement' };
    if (!Array.isArray(params.elements) || !params.elements.length || params.elements.length > 1000 ||
      params.elements.some(element => !element || ![1, 2, 3, 4, 5, 6, 7, 10].includes(element.elementType) ||
        Object.entries(element).some(([key, value]) => key.endsWith('Element') && key !== payloads[element.elementType] && value !== null && value !== undefined) ||
        (element.elementType === 6 && (!Number.isInteger(element.faceElement?.faceIndex) || element.faceElement.faceIndex < 0 ||
          element.faceElement.faceIndex > 65535 || [358, 359].includes(element.faceElement.faceIndex) || ![1, 2].includes(element.faceElement.faceType))))) {
      throw problem('INVALID_PARAMS', 'Expected supported kernel message elements');
    }
    const musicTokens = new Set(), shareTokens = new Set();
    for (const element of params.elements) if (element.elementType === 2) {
      // Re-read the exact prepared cache data to reject arbitrary file reads or
      // changed files before handing sourcePath to QQ's native uploader.
      const image = element.picElement;
      const prepared = image && this.preparedMedia.get(image.sourcePath);
      if (!image || !/^[a-f0-9]{32}$/.test(image.md5HexStr || '') || typeof image.sourcePath !== 'string' ||
        !prepared || prepared.type !== 'image' || prepared.epoch !== epoch || prepared.md5 !== image.md5HexStr || Date.now() - prepared.at > 300000) {
        throw problem('INVALID_PARAMS', 'Image was not prepared in this account native cache');
      }
      media.verifyPrepared(image.sourcePath, this.mediaTargetRoots, prepared);
    } else if (element.elementType === 3) {
      const file = element.fileElement;
      const prepared = file && this.preparedMedia.get(file.filePath);
      if (!file || !prepared || prepared.type !== 'file' || prepared.epoch !== epoch ||
        Date.now() - prepared.at > 300000 || file.fileSize !== String(prepared.size) ||
        typeof file.fileName !== 'string' || !file.fileName.trim() || ['.', '..'].includes(file.fileName) || /[\\/\x00-\x1f\x7f-\x9f]/.test(file.fileName) ||
        Buffer.byteLength(file.fileName) > 255 || file.folderId !== '') throw problem('INVALID_PARAMS', 'File was not prepared in this account native cache');
      media.verifyPrepared(file.filePath, this.mediaTargetRoots, prepared);
    } else if (element.elementType === 4) {
      const ptt = element.pttElement, prepared = ptt && this.preparedMedia.get(ptt.filePath);
      if (!prepared || prepared.type !== 'record' || prepared.epoch !== epoch || Date.now() - prepared.at > 300000 ||
        ptt.md5HexStr !== prepared.md5 || ptt.fileSize !== String(prepared.size) || ptt.duration !== prepared.duration ||
        ptt.formatType !== 1 || ptt.voiceType !== 1 || ptt.voiceChangeType !== 0 || ptt.canConvert2Text !== false ||
        JSON.stringify(ptt.waveAmplitudes) !== JSON.stringify(prepared.waveAmplitudes) || ptt.fileSubId !== '' ||
        ptt.playState !== 1 || ptt.autoConvertText !== 0 || ptt.storeID !== 0 || ptt.otherBusinessInfo?.aiVoiceType !== 0 ||
        Object.keys(ptt.otherBusinessInfo).some(key => key !== 'aiVoiceType') ||
        Object.keys(ptt).some(key => !['fileName', 'filePath', 'md5HexStr', 'fileSize', 'duration', 'formatType', 'voiceType',
          'voiceChangeType', 'canConvert2Text', 'waveAmplitudes', 'fileSubId', 'playState', 'autoConvertText', 'storeID', 'otherBusinessInfo'].includes(key)) ||
        ptt.fileName !== prepared.md5 + '.silk') throw problem('INVALID_PARAMS', 'Voice was not prepared in this account native cache');
      media.verifyPrepared(ptt.filePath, this.mediaTargetRoots, prepared);
    } else if (element.elementType === 5) {
      this.verifyVideo(element, epoch);
    } else if (element.elementType === 10 && element.shareToken !== undefined) {
      const token = this.shareCards.verify(element, peer);
      if (shareTokens.has(token)) throw problem('INVALID_PARAMS', 'A share capability cannot occur twice in one send');
      shareTokens.add(token);
    } else if (element.elementType === 10) {
      const prepared = this.preparedMusic.get(element.musicToken);
      if (!prepared || prepared.epoch !== epoch || prepared.peer.chatType !== peer.chatType || prepared.peer.peerUid !== peer.peerUid ||
        musicTokens.has(element.musicToken) ||
        Date.now() - prepared.at > 60000 || element.arkElement?.bytesData !== prepared.card ||
        element.arkElement.linkInfo !== null || element.arkElement.subElementType !== null ||
        Object.keys(element.arkElement).some(key => !['bytesData', 'linkInfo', 'subElementType'].includes(key))) {
        throw problem('INVALID_PARAMS', 'Music card was not prepared for this account and conversation');
      }
      validateMusicCard(element.arkElement.bytesData);
      musicTokens.add(element.musicToken);
    }
    const elements = params.elements.map(element => {
      if (element.elementType === 5) return { ...element, videoElement: { ...element.videoElement,
        thumbPath: new Map([[0, element.videoElement.thumbPath['0']]]) } };
      if (element.elementType === 4) return { ...element, pttElement: { ...element.pttElement,
        waveAmplitudes: [...element.pttElement.waveAmplitudes], otherBusinessInfo: { ...element.pttElement.otherBusinessInfo } } };
      if (element.elementType !== 10) return element;
      // One-use credentials stay inside the bridge and never enter native QQ.
      if (element.shareToken !== undefined) this.shareCards.consume(element.shareToken);
      this.preparedMusic.delete(element.musicToken);
      return { elementType: 10, elementId: '', arkElement: { ...element.arkElement } };
    });
    return this.sendNativeElements(peer, elements, context, { expectedEpoch: epoch, timeoutMs: params.timeoutMs ?? 10000,
      observePrivateFile: peer.chatType === 1 && elements.length === 1 && elements[0].elementType === 3,
      verifyBeforeSubmit: () => {
        for (const element of elements) {
          const filename = element.picElement?.sourcePath || element.fileElement?.filePath || element.pttElement?.filePath || element.videoElement?.filePath;
          if ([2, 3, 4, 5].includes(element.elementType)) {
            const prepared = this.preparedMedia.get(filename);
            if (!prepared || prepared.epoch !== epoch) throw problem('INVALID_PARAMS', 'Prepared media expired before submission');
            media.verifyPrepared(filename, this.mediaTargetRoots, prepared);
            if (element.elementType === 5) media.verifyPrepared(element.videoElement.thumbPath.get(0), this.mediaTargetRoots, prepared.thumbnail);
          }
        }
      } });
  }

  // Internal only: this method is deliberately absent from the RPC method
  // allowlist. Callers must validate and own every native element before entry.
  // Normal sends and native merge probes share exactly the same delivery proof.
  async sendNativeElements(peer, elements, context, { expectedEpoch, timeoutMs = 10000, verifyBeforeSubmit, requireSenderUid = false,
    observePrivateFile = false } = {}) {
    this.ensureReady();
    const epoch = this.epoch, selfUin = this.self?.uin, selfUid = this.self?.uid, session = this.session;
    if (!selfUin || !selfUid || expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Native send does not match the authenticated QQ session');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw problem('INVALID_PARAMS', 'Invalid send timeout');
    const expiresAt = Math.min(context.expiresAt ?? Infinity, Date.now() + timeoutMs);
    const ensureActive = () => {
      if (this.closed || !this.ready || this.epoch !== epoch || this.self?.uin !== selfUin || this.self?.uid !== selfUid || this.session !== session) {
        throw problem('SESSION_CHANGED', 'QQ session changed before sending');
      }
      if (context.signal?.aborted || Date.now() >= expiresAt) throw problem('EXPIRED', 'Send deadline expired before submission');
    };
    let handler, observer, pollTimer, pinnedId, stopped = false, dispatched = false, deliveredDone = false, queryInFlight = false;
    let acceptanceState = 'not-dispatched', acceptanceThenable = false, exactCallbacks = 0, lastStatus = null;
    let queryCount = 0, queryResult = this.hasMethods('msg', ['getMsgsByMsgId']) ? 'not-started' : 'unavailable';
    let phase = 'server-time', callbackCount = 0, ownPeerCallbacks = 0, nonemptyGuildCallbacks = 0;
    const evidence = { at: Date.now(), phase, outcome: 'pending', dispatched: false, acceptance: acceptanceState,
      acceptanceThenable, callbackCount, ownPeerCallbacks, nonemptyGuildCallbacks, exactCallbacks,
      pinned: false, lastStatus, queryCount, queryResult, deliverySettled: false };
    // The flag is internal and is enabled only after sendMessage validates a
    // prepared private single-file payload. It never changes delivery proof.
    const fileUpload = observePrivateFile && peer.chatType === 1 && elements.length === 1 && elements[0].elementType === 3
      ? createFileUploadObserver({ selfUin, selfUid, peer, isActive: () => !stopped && !this.closed && this.ready &&
        this.epoch === epoch && this.self?.uin === selfUin && this.self?.uid === selfUid && this.session === session &&
        !context.signal?.aborted && Date.now() < expiresAt }) : null;
    let fileUploadHandler;
    const closeFileUpload = () => {
      if (!fileUpload) return;
      if (fileUploadHandler) this.bus.removeListener('fileUploadObservation', fileUploadHandler);
      fileUploadHandler = undefined; fileUpload.close(); evidence.privateFileUpload = fileUpload.snapshot();
    };
    this.sendDiagnostics.push(evidence);
    if (this.sendDiagnostics.length > 8) this.sendDiagnostics.shift();
    const updateEvidence = () => {
      if (evidence.outcome !== 'pending') return;
      Object.assign(evidence, { phase, dispatched, acceptance: acceptanceState, acceptanceThenable, callbackCount,
        ownPeerCallbacks, nonemptyGuildCallbacks, exactCallbacks, pinned: Boolean(pinnedId), lastStatus,
        queryCount, queryResult, deliverySettled: deliveredDone });
      if (fileUpload) evidence.privateFileUpload = fileUpload.snapshot();
    };
    let evidenceTimer;
    const finishEvidence = outcome => {
      if (evidence.outcome !== 'pending') return;
      updateEvidence(); evidence.outcome = outcome; evidence.finishedAt = Date.now();
      closeFileUpload();
      clearTimeout(evidenceTimer); context.signal?.removeEventListener('abort', evidenceAbort);
    };
    const evidenceAbort = () => finishEvidence(Date.now() >= expiresAt ? 'timeout' : 'cancelled');
    const evidenceTimeout = () => {
      const left = expiresAt - Date.now();
      if (left > 0) evidenceTimer = setTimeout(evidenceTimeout, Math.max(1, Math.ceil(left)));
      else finishEvidence('timeout');
    };
    evidenceTimer = setTimeout(evidenceTimeout, Math.max(1, Math.ceil(expiresAt - Date.now())));
    context.signal?.addEventListener('abort', evidenceAbort, { once: true });
    try {
      ensureActive();
      const time = await this.invoke('msf', 'getServerTime', []);
      ensureActive();
      phase = 'correlation'; updateEvidence();
      const correlation = String(await this.invoke('msg', 'generateMsgUniqueId', [peer.chatType, time]));
      ensureActive();
      if (!/^\d+$/.test(correlation)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid send correlation ID');
      const queryController = new AbortController();
      const queryContext = { ...context, expiresAt, signal: context.signal
        ? AbortSignal.any([context.signal, queryController.signal]) : queryController.signal };
      let resolveDelivery, rejectDelivery;
      const ownPeer = record => record && record.chatType === peer.chatType && record.peerUid === peer.peerUid &&
        String(record.senderUin) === selfUin && (!requireSenderUid || record.senderUid === selfUid);
      const fullId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
      const settle = (error, record) => {
        if (stopped || deliveredDone) return;
        deliveredDone = true; clearTimeout(pollTimer); pollTimer = undefined;
        updateEvidence();
        if (error) rejectDelivery(error); else resolveDelivery(record);
      };
      const schedulePoll = () => {
        if (stopped || deliveredDone || pollTimer || queryInFlight || !pinnedId || acceptanceState === 'rejected' || queryResult === 'unavailable' ||
            queryCount >= Math.min(751, Math.ceil(timeoutMs / 400) + 1) || Date.now() >= expiresAt) return;
        pollTimer = setTimeout(() => { pollTimer = undefined; poll().catch(() => {}); }, queryCount ? 400 : 0);
      };
      const poll = async () => {
        if (stopped || deliveredDone || acceptanceState === 'rejected') return;
        queryInFlight = true;
        try {
          ensureActive(); queryCount++; queryResult = 'pending'; updateEvidence();
          const result = await this.deadline(() => this.invoke('msg', 'getMsgsByMsgId',
            [{ ...peer, guildId: '' }, [pinnedId]]), queryContext, timeoutMs);
          if (stopped || deliveredDone) return;
          ensureActive();
          if (!result || result.result !== 0) queryResult = 'rejected';
          else if (!Array.isArray(result.msgList)) queryResult = 'invalid-shape';
          else if (result.msgList.length === 0) queryResult = 'not-found';
          else {
            const record = result.msgList[0];
            if (result.msgList.length !== 1 || !ownPeer(record) || record.senderUid !== selfUid || record.msgId !== pinnedId) {
              queryResult = 'identity-mismatch';
            } else {
              queryResult = 'exact'; lastStatus = Number.isInteger(record.sendStatus) ? record.sendStatus : null;
              fileUpload?.bind(record, pinnedId);
              if (record.sendStatus === 2) { settle(null, record); return; }
              if (record.sendStatus === 0) { settle(problem('SEND_FAILED', 'QQ reported failed message delivery')); return; }
            }
          }
        } catch (error) {
          if (stopped || deliveredDone) return;
          queryResult = ['TIMEOUT', 'EXPIRED'].includes(error?.code) ? 'timeout' : 'error';
        } finally { queryInFlight = false; updateEvidence(); }
        schedulePoll();
      };
      const delivered = new Promise((resolve, reject) => {
        resolveDelivery = resolve; rejectDelivery = reject;
        observer = observation => {
          if (!dispatched || stopped || !Array.isArray(observation?.records) ||
              !['onAddSendMsg', 'onMsgInfoListUpdate'].includes(observation.callback)) return;
          for (const record of observation.records) {
            callbackCount = Math.min(1000000, callbackCount + 1);
            if (ownPeer(record)) {
              ownPeerCallbacks = Math.min(1000000, ownPeerCallbacks + 1);
              if (typeof record.guildId === 'string' && record.guildId.length > 0) nonemptyGuildCallbacks = Math.min(1000000, nonemptyGuildCallbacks + 1);
            }
            updateEvidence();
            if (!ownPeer(record) || String(record.guildId) !== correlation) continue;
            exactCallbacks = Math.min(1000000, exactCallbacks + 1);
            lastStatus = Number.isInteger(record.sendStatus) ? record.sendStatus : null;
            updateEvidence();
            // An early correlated record binds the real native ID before QQ
            // clears guildId. Never infer an ID from content or the generated ID.
            if (!fullId(record.msgId) || record.senderUid !== selfUid) continue;
            if (pinnedId && pinnedId !== record.msgId) {
              settle(problem('INVALID_RESPONSE', 'QQ changed the correlated native message identity')); return;
            }
            pinnedId = record.msgId; fileUpload?.bind(record, pinnedId); updateEvidence(); schedulePoll();
          }
        };
        this.bus.on('sendObservation', observer);
        handler = records => { for (const record of records) {
          if (!dispatched || stopped) return;
          if (String(record.guildId) !== correlation || record.chatType !== peer.chatType || record.peerUid !== peer.peerUid) continue;
          if (this.epoch !== epoch || this.self?.uin !== selfUin || this.self?.uid !== selfUid || this.session !== session) {
            settle(problem('SESSION_CHANGED', 'QQ account changed during sending')); return;
          }
          if (String(record.senderUin) !== selfUin || requireSenderUid && record.senderUid !== selfUid ||
              record.senderUid !== undefined && record.senderUid !== selfUid) continue;
          if (record.sendStatus === 2 && typeof record.msgId === 'string') settle(null, record);
          else if (record.sendStatus === 0) settle(problem('SEND_FAILED', 'QQ reported failed message delivery'));
        } };
        this.bus.on('sent', handler);
      });
      // Observe rejection immediately even if QQ rejects its acceptance Promise.
      delivered.catch(() => {});
      if (fileUpload) {
        fileUploadHandler = observation => {
          if (!dispatched || stopped || evidence.outcome !== 'pending') return;
          fileUpload.observe(observation?.callback, observation?.args); updateEvidence();
        };
        this.bus.on('fileUploadObservation', fileUploadHandler);
      }
      try {
        return await this.deadline(async () => {
          ensureActive();
          phase = 'verify'; updateEvidence();
          if (verifyBeforeSubmit) verifyBeforeSubmit();
          ensureActive();
          dispatched = true; acceptanceState = 'pending'; phase = 'native-send'; updateEvidence();
          let accepted;
          try { accepted = this.invoke('msg', 'sendMsg', ['0', { ...peer, guildId: correlation }, elements, new Map()]); }
          catch (error) { acceptanceState = 'rejected'; updateEvidence(); throw error; }
          acceptanceThenable = Boolean(accepted && typeof accepted.then === 'function');
          phase = 'confirmation'; updateEvidence();
          let acceptanceError;
          const acceptedProof = Promise.resolve(accepted).then(result => {
            try { confirmed(result); } catch (error) { acceptanceState = 'rejected'; acceptanceError = error; updateEvidence(); throw error; }
            acceptanceState = 'accepted'; updateEvidence(); schedulePoll(); return result;
          }, error => { acceptanceState = 'rejected'; acceptanceError = error; updateEvidence(); throw error; });
          // A real correlated status=2 is QQ's delivery confirmation. On this
          // QQ version the sendMsg Promise can remain pending after that exact
          // callback, so it must not block proven delivery. Its rejection is
          // still observed and takes priority if known before completion.
          const record = await new Promise((resolve, reject) => {
            let received;
            const complete = () => {
              if (acceptanceState === 'rejected') { reject(acceptanceError); return; }
              if (!received) return;
              const strongDelivery = ownPeer(received) && received.senderUid === selfUid && fullId(received.msgId) &&
                received.sendStatus === 2 && (String(received.guildId) === correlation || received.msgId === pinnedId && queryResult === 'exact');
              if (acceptanceState === 'accepted' || strongDelivery) resolve(received);
            };
            acceptedProof.then(complete, reject);
            delivered.then(value => { received = value; complete(); }, reject);
          });
          ensureActive();
          finishEvidence('success');
          return record;
        }, context, timeoutMs);
      } catch (error) {
        if (dispatched && ['TIMEOUT', 'EXPIRED'].includes(error?.code)) {
          this.diagnostic(problem('SEND_CONFIRMATION_TIMEOUT', JSON.stringify({ acceptance: acceptanceState,
            acceptanceThenable, exactCallbacks, pinned: Boolean(pinnedId), lastStatus, queryCount, queryResult })));
        }
        throw error;
      } finally {
        closeFileUpload();
        stopped = true; clearTimeout(pollTimer); queryController.abort();
        this.bus.removeListener('sent', handler); this.bus.removeListener('sendObservation', observer);
      }
    } catch (error) {
      finishEvidence(['TIMEOUT', 'EXPIRED'].includes(error?.code) ? 'timeout' :
        error?.code === 'SESSION_CHANGED' ? 'session-changed' : 'failed');
      throw error;
    } finally {
      if (evidence.outcome === 'pending') finishEvidence('failed');
      closeFileUpload();
    }
  }

  async call(method, params = {}, context = {}) {
    if (!METHODS.has(method)) throw problem('UNSUPPORTED', 'Unknown kernel method');
    if (method === 'status') return this.state();
    this.ensureReady();
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw problem('INVALID_PARAMS', 'Expected parameters object');
    const profile = this.runtimeProfile();
    if (!runtimeProfile.permitsMethod(profile, method, params)) throw annotate(problem('UNSUPPORTED',
      profile.admission === 'denied' ? 'QQ runtime profile is not admitted' : 'This operation is disabled in the experimental QQ profile'),
      { reason: profile.admission === 'denied' ? 'runtime_profile_denied' : 'experimental_operation_disabled', phase: 'session' });
    if (params.expectedEpoch !== undefined && params.expectedEpoch !== this.epoch) {
      throw problem('SESSION_CHANGED', 'Kernel request belongs to a different QQ session');
    }
    const controller = new AbortController();
    const timeoutMs = method === 'sendMessage' ? (params.timeoutMs ?? 10000) :
      method === 'voiceExtra' || method === 'forwardUpload' || method === 'flashTransfer' && params.operation === 'create' || method === 'groupAlbumAction' && ['album.uploadImage', 'album.uploadVideo'].includes(params.operation) || method === 'qzoneAction' && params.operation === 'qzone.publish' ? 60000 :
      method === 'forwardOperation' && ['customMerge', 'customResourceMerge', 'existingMerge'].includes(params.kind) ? (params.timeoutMs ?? 60000) :
        ['prepareMedia', 'receiveMedia', 'recordExport', 'customFaceQuery', 'customFaceAction'].includes(method) ? 60000 :
          ['nativeRkey', 'nativeGroupFileUrl', 'nativeGroupFileSpace', 'nativePrivateFileUrl'].includes(method) ? (params.timeoutMs ?? 10000) : 10000;
    // All preparation, native calls and confirmation reads share the same
    // absolute end. Inner operations cannot create a later private deadline.
    const scoped = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + timeoutMs),
      signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
    try {
      return await this.deadline(() => this[method](params, scoped), scoped, timeoutMs);
    } finally {
      // An outer deadline must also retire callback waiters inside the operation.
      controller.abort();
      await Promise.resolve();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.readyAt = null;
    this.online = null;
    this.preparedMedia.clear();
    this.preparedMusic.clear();
    this.receivedMedia.clear();
    this.forward.clear(); this.reverse.clear();
    this.forwardApi.clear();
    this.shareCards.clear();
    clearInterval(this.observerTimer); this.observerTimer = null;
    this.rejectPending(problem('NOT_READY', 'QQ capture stopped'));
    this.detach();
    this.social.close();
    this.groupQueriesApi.clear();
    this.extendedQueries2Api.clear();
    this.contactExtraApi.clear();
    this.flashTransferApi.clear(); this.qzoneApi.clear(); this.friendDressApi.clear(); this.voiceExtraApi.clear(); this.authExtraApi.clear(); this.modelShowApi.clear(); this.urlSafetyApi.clear(); this.collectionCreateApi.clear(); this.emojiSummaryApi.clear(); this.anonymousApi.clear();
    if (this.processObject.dlopen === this.dlopenHook) this.processObject.dlopen = this.originalDlopen;
    for (const restore of this.restorations.reverse()) { try { restore(); } catch (error) { this.diagnostic(error); } }
    this.restorations.length = 0;
    this.publishState();
  }
}

function createCapture(options) { return new Capture(options); }
module.exports = { Capture, createCapture, TARGET_VERSION };
