/*
 * Freshwater MSF read-only probe (N-API, ABI-stable).
 *
 * Loads inside QQ's Electron main process via require(). Resolves wrapper.node's
 * load base from an exported MSF::MSFSDK symbol, then reads the MSFCoreService
 * global shared_ptr slot and validates the instance vptr. PURELY READ-ONLY:
 * no QQ function is called, no memory is written, no packet is sent.
 *
 * RVAs are specific to QQ 3.2.35-54395 linux x64 (wrapper.node build 29595d4c6b8f42ee).
 * They MUST be re-verified (tools/msf-x64 recon) before use on any other build.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <link.h>
#include <stdint.h>
#include <string.h>

/* --- version-specific RVAs (QQ 3.2.35-54395 x64) --- */
#define RVA_SENDPACKET        0x670dd20ULL  /* MSF::MSFSDK::sendPacket (export) */
#define RVA_SEND_MSF_REQUEST  0x3550ff0ULL  /* MSFCoreService::SendMsfRequest */
#define RVA_INTERNAL          0x35505a0ULL  /* MSFCoreService::SendMsfRequestInternal */
#define RVA_PRIMARY_VTABLE    0x8e82c48ULL  /* MSFCoreService primary vtable (fn0) */
#define RVA_GLOBAL_SLOT       0x916e750ULL  /* .bss shared_ptr {raw, ctrl} */
#define RVA_ONCE_GUARD        0x916e760ULL
#define SIZEOF_MSFCORE        0x3c0U

#define SENDPACKET_SYM "_ZN3MSF6MSFSDK10sendPacketENSt2Cr10unique_ptrINS_10MSFRequestENS1_14default_deleteIS3_EEEE"

static napi_value make_string(napi_env env, const char *s) {
    napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v;
}
static napi_value make_u64(napi_env env, uint64_t x) {
    napi_value v; napi_create_bigint_uint64(env, x, &v); return v;
}
static void set(napi_env env, napi_value obj, const char *k, napi_value v) {
    napi_set_named_property(env, obj, k, v);
}

/* Resolve wrapper.node base via an exported symbol; cross-check dladdr fbase. */
static int resolve_base(uintptr_t *out_base, uintptr_t *out_sendpacket) {
    void *sym = dlsym(RTLD_DEFAULT, SENDPACKET_SYM);
    if (!sym) return 0;
    Dl_info info; memset(&info, 0, sizeof(info));
    if (!dladdr(sym, &info) || !info.dli_fbase) return 0;
    uintptr_t base = (uintptr_t)info.dli_fbase;
    /* sanity: symbol address must equal base + known RVA */
    if ((uintptr_t)sym != base + RVA_SENDPACKET) {
        /* fbase may differ from RVA base on some loaders; derive from symbol */
        base = (uintptr_t)sym - RVA_SENDPACKET;
    }
    *out_base = base;
    *out_sendpacket = (uintptr_t)sym;
    return 1;
}

static napi_value Probe(napi_env env, napi_callback_info info) {
    napi_value obj; napi_create_object(env, &obj);
    uintptr_t base = 0, sp = 0;
    if (!resolve_base(&base, &sp)) {
        set(env, obj, "ok", make_string(env, "false"));
        set(env, obj, "error", make_string(env, "wrapper.node MSFSDK::sendPacket export not found in this process"));
        return obj;
    }
    set(env, obj, "ok", make_string(env, "true"));
    set(env, obj, "base", make_u64(env, base));
    set(env, obj, "sendPacket", make_u64(env, sp));
    set(env, obj, "sendMsfRequest", make_u64(env, base + RVA_SEND_MSF_REQUEST));
    set(env, obj, "sendMsfRequestInternal", make_u64(env, base + RVA_INTERNAL));
    set(env, obj, "primaryVtable", make_u64(env, base + RVA_PRIMARY_VTABLE));
    set(env, obj, "sizeofMSFCoreService", make_u64(env, SIZEOF_MSFCORE));

    /* read global shared_ptr raw pointer (guard null) */
    uintptr_t slot = base + RVA_GLOBAL_SLOT;
    uintptr_t raw = *(volatile uintptr_t *)slot;
    set(env, obj, "globalSlot", make_u64(env, slot));
    set(env, obj, "instancePtr", make_u64(env, raw));
    if (raw) {
        uintptr_t vptr = *(volatile uintptr_t *)raw;
        uintptr_t expect = base + RVA_PRIMARY_VTABLE;
        set(env, obj, "vptr", make_u64(env, vptr));
        set(env, obj, "vptrExpected", make_u64(env, expect));
        set(env, obj, "instanceValid", make_string(env, vptr == expect ? "true" : "false"));
        /* signer presence: this+0x70 (security_sign_callback_) */
        uintptr_t signer = *(volatile uintptr_t *)(raw + 0x70);
        set(env, obj, "signerPresent", make_string(env, signer ? "true" : "false"));
    } else {
        set(env, obj, "instanceValid", make_string(env, "false"));
        set(env, obj, "note", make_string(env, "global slot empty: MSFCoreService not constructed yet"));
    }
    uintptr_t once = *(volatile uintptr_t *)(base + RVA_ONCE_GUARD);
    set(env, obj, "onceGuard", make_u64(env, once));
    return obj;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn; napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, NULL, &fn);
    napi_set_named_property(env, exports, "probe", fn);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)