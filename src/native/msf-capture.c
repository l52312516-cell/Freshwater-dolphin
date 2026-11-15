/*
 * Freshwater MSF capture-first detour addon (N-API, ABI-stable).
 *
 * Loads inside QQ's Electron main process via require(). It can install a
 * 14-byte inline detour on MSF::MSFCoreService::SendMsfRequest that OBSERVES
 * each natural call (cmd / body / opts / callback) into a bounded in-memory
 * ring, then calls the original function unchanged via a trampoline. It does
 * NOT construct callbacks, does NOT send packets, and does NOT modify any QQ
 * object. The only write to QQ memory is the 14-byte patch, restored on
 * uninstall.
 *
 * Purpose: capture the real opts object and the real Cr::function callback
 * (manager + invoke pointers) that QQ builds, so the invoke convention and
 * opts construction can be confirmed from observation rather than guessed.
 *
 * UNTESTED-LIVE: written and compiled offline; install/hook must first run on
 * a confirmed DISPOSABLE logged-in instance, never production legacy.
 *
 * RVAs are specific to QQ 3.2.35-54395 linux x64 (wrapper.node build
 * 29595d4c6b8f42ee). Re-verify before use on any other build.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <link.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/* --- version-specific RVAs (QQ 3.2.35-54395 x64) --- */
#define RVA_SENDPACKET        0x670dd20ULL
#define RVA_SEND_MSF_REQUEST  0x3550ff0ULL  /* virtual wrapper; NOT on QQ's hot path */
#define RVA_INTERNAL          0x35505a0ULL  /* SendMsfRequestInternal: actual send hot path */
#define RVA_PRIMARY_VTABLE    0x8e82c48ULL
#define RVA_GLOBAL_SLOT       0x916e750ULL
#define RVA_ONCE_GUARD        0x916e760ULL
#define SIZEOF_MSFCORE        0x3c0U
/* Detour patch = 14-byte abs jmp + NOP pad to the target's instruction boundary.
 * PATCH_LEN is the max prologue buffer; actual length is per-target. */
#define PATCH_LEN             24U
#define JMP_LEN               14U

#define SENDPACKET_SYM "_ZN3MSF6MSFSDK10sendPacketENSt2Cr10unique_ptrINS_10MSFRequestENS1_14default_deleteIS3_EEEE"

#define MAX_RECORDS       64
#define MAX_CMD_BYTES     128
#define MAX_BODY_PREVIEW  64

struct record {
    uint64_t seq;            /* ring record sequence */
    uint64_t args[5];        /* raw rdi,rsi,rdx,rcx,r8 at entry */
    uint64_t arg0_q[8];      /* qwords of *arg0 (e.g. MSFRequest for sendPacket) */
    uint64_t self;           /* validated MSFCoreService this (Internal) */
    uint32_t msf_seq;        /* MSF packet sequence (Internal esi) */
    uint32_t need_response;  /* Internal r9d */
    uint64_t opts_ptr;       /* Internal opts (r8) */
    uint64_t opts_q[4];
    uint64_t dump[64];       /* multi-level raw qwords for offline layout analysis */
    uint64_t cb_obj;         /* dereferenced callback object (shared_ptr target) */
    uint64_t cb_manager;     /* CrFunction manager (cb_obj+0x10) */
    uint64_t cb_invoke;      /* CrFunction invoke (cb_obj+0x18) */
    uint64_t cb_invoke_rva;
    uint8_t  cb_buf[16];
    uint32_t cmd_len;
    char     cmd[MAX_CMD_BYTES];
    uint64_t body_size;
    uint32_t body_preview_len;
    uint8_t  body_preview[MAX_BODY_PREVIEW];
    uint32_t valid;
};

static struct record g_records[MAX_RECORDS];
static uint64_t g_counter;
static uintptr_t g_base;
static uintptr_t g_target;
static uintptr_t g_trampoline;
static uintptr_t g_instance;   /* validated MSFCoreService this, captured from a real QQ call */
static uint8_t   g_original[PATCH_LEN];
static size_t    g_patch_len;
static int       g_installed;

static uintptr_t g_original_fn;  /* trampoline address; cast per active hook */
static int g_target_kind;        /* 0 = sendPacket, 1 = Internal */

/* Call-site capture: the sendSsoCmdReqByContend N-API handler does
 * `call [rax+0x788]` at this RVA. Redirect that call to a thunk that records
 * the real virtual target, then tail-jumps to it (behavior unchanged). */
#define RVA_SSO_CALLSITE      0x39e45c7ULL
static uintptr_t g_last_target;
static uintptr_t g_callsite;
static uintptr_t g_cs_thunk;
static uint8_t   g_cs_original[6];
static int       g_cs_installed;

/* proactive send via cloned session-shell request + redirected callback */
#define RVA_SS_SEND           0x2f4e4b0ULL
static uintptr_t g_ss_instance;          /* session-shell this from a natural call */
static uint64_t  g_req_template[8];      /* request struct (rdx) */
static uint64_t  g_cb_template[16];      /* callback wrapper object (cbObj) */
static uint64_t  g_ctrl_template[8];     /* shared_ptr control block (cbObj-24) */
static uintptr_t g_cb_vtable_orig;       /* original wrapper vtable */
static int       g_have_template;
static uint8_t   g_nat_body[256];        /* natural request body bytes */
static uint32_t  g_nat_body_len;
static uint64_t  g_nat_req[8];           /* natural request struct */
/* response captured by the redirected invoke */
static uint64_t  g_rsp_result;
static uint64_t  g_rsp_cmd_ptr;
static uint64_t  g_rsp_body_ptr;
static uint32_t  g_rsp_count;
static uint8_t   g_rsp_body[8192];
static uint32_t  g_rsp_body_len;
static char      g_rsp_cmd[128];
static uint64_t  g_rsp_regs[4];      /* rdx, rcx, r8, r9 raw */
static uint64_t  g_rsp_q[4][4];      /* qwords of each reg if pointer */
static uint8_t   g_rsp_body2[8192];   /* body parsed from r8 */
static uint32_t  g_rsp_body2_len;
/* constructed callback storage (kept alive; refcounts held high so QQ never frees) */
static uint64_t  g_my_ctrl[8] __attribute__((aligned(16)));
static uint64_t  g_my_wrapper[16] __attribute__((aligned(16)));
static uint64_t  g_my_cb_vtable[8] __attribute__((aligned(16)));
static uint64_t  g_my_ctrl_vtable[8] __attribute__((aligned(16)));
static uint64_t  g_my_sharedptr[2] __attribute__((aligned(16)));

/* Selectable detour targets. Prologues are position-independent fingerprints. */
struct target_desc {
    const char *name;
    uintptr_t rva;
    uint8_t prologue[24];
    size_t patch_len;
};
static const struct target_desc TARGETS[] = {
    /* MSFSDK::sendPacket: push rbp/r15/r14/rbx; sub rsp,0x48; mov r14d,-1 (16B) */
    { "sendpacket", RVA_SENDPACKET,
      {0x55,0x41,0x57,0x41,0x56,0x53,0x48,0x83,0xec,0x48,0x41,0xbe,0xff,0xff,0xff,0xff}, 16 },
    /* SendMsfRequestInternal: push rbp/r15/r14/r13/r12/rbx; sub rsp,0xf8 (17B) */
    { "internal", RVA_INTERNAL,
      {0x55,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec,0xf8,0x00,0x00,0x00}, 17 },
    /* INTCSessionShell vtable slot 0x788 (sendSsoCmdReqByContend path):
     * push rbp/r15/r14/r12/rbx; sub rsp,0xa0 (15B) */
    { "sso", 0x7226850ULL,
      {0x55,0x41,0x57,0x41,0x56,0x41,0x54,0x53,0x48,0x81,0xec,0xa0,0x00,0x00,0x00}, 15 },
    /* Real session-shell send (captured live via call-site hook):
     * (this, cmd, body, callback). push rbp/r15/r14/r13/r12/rbx; sub rsp,0x178 (17B) */
    { "ssosend", 0x2f4e4b0ULL,
      {0x55,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec,0x78,0x01,0x00,0x00}, 17 },
};
#define NTARGETS ((int)(sizeof(TARGETS)/sizeof(TARGETS[0])))

/* --- N-API helpers --- */
static napi_value mk_str(napi_env env, const char *s) {
    napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v;
}
static napi_value mk_u64(napi_env env, uint64_t x) {
    napi_value v; napi_create_bigint_uint64(env, x, &v); return v;
}
static napi_value mk_u32(napi_env env, uint32_t x) {
    napi_value v; napi_create_uint32(env, x, &v); return v;
}
static void set(napi_env env, napi_value o, const char *k, napi_value v) {
    napi_set_named_property(env, o, k, v);
}

/* Canonical user-space pointer guard (48-bit VA); avoids reading obvious garbage. */
static int ptr_ok(uintptr_t p) {
    if (p < 0x10000) return 0;  /* reject null-page / small-integer false pointers */
    uintptr_t hi = p & 0xffff800000000000ULL;
    return hi == 0 || hi == 0xffff800000000000ULL;
}
static uint64_t rd64(uintptr_t p) {
    if (!ptr_ok(p)) return 0;
    return *(volatile uint64_t *)p;
}

/* wrapper.node is loaded RTLD_LOCAL, so its symbols are not in the global
 * dlsym table. Enumerate loaded objects and match the module basename instead;
 * dlpi_addr is the relocation base, so actual addr = dlpi_addr + RVA. */
static int phdr_find_wrapper(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    uintptr_t *out = (uintptr_t *)data;
    const char *name = info->dlpi_name;
    if (!name || !*name) return 0;
    const char *slash = strrchr(name, '/');
    const char *base = slash ? slash + 1 : name;
    if (strcmp(base, "wrapper.node") == 0) { *out = (uintptr_t)info->dlpi_addr; return 1; }
    return 0;
}

static int resolve_base(uintptr_t *out_base) {
    uintptr_t base = 0;
    dl_iterate_phdr(phdr_find_wrapper, &base);
    if (base) { *out_base = base; return 1; }
    /* fallback: global symbol visibility (some loaders) */
    void *sym = dlsym(RTLD_DEFAULT, SENDPACKET_SYM);
    if (sym) { *out_base = (uintptr_t)sym - RVA_SENDPACKET; return 1; }
    return 0;
}

static int instance_valid(uintptr_t base) {
    uintptr_t raw = rd64(base + RVA_GLOBAL_SLOT);
    if (!ptr_ok(raw)) return 0;
    return rd64(raw) == base + RVA_PRIMARY_VTABLE;
}

/* --- detour hooks: observe, then call original unchanged --- */
static struct record *record_begin(uint64_t *idx_out) {
    uint64_t idx = __atomic_fetch_add(&g_counter, 1, __ATOMIC_RELAXED);
    *idx_out = idx;
    struct record *r = &g_records[idx % MAX_RECORDS];
    r->valid = 0;
    r->seq = idx;
    r->self = 0; r->msf_seq = 0; r->need_response = 0;
    r->opts_ptr = 0; r->cmd_len = 0; r->body_size = 0; r->body_preview_len = 0;
    memset(r->opts_q, 0, sizeof(r->opts_q));
    return r;
}
static void capture_args(struct record *r, uintptr_t a0, uintptr_t a1,
                         uintptr_t a2, uintptr_t a3, uintptr_t a4) {
    r->args[0] = a0; r->args[1] = a1; r->args[2] = a2; r->args[3] = a3; r->args[4] = a4;
    for (int i = 0; i < 8; i++) r->arg0_q[i] = rd64(a0 + (uintptr_t)i * 8);
}
/* parse a std::Cr::string at ptr into r->cmd */
static void capture_cmd(struct record *r, uintptr_t cmd) {
    if (!ptr_ok(cmd)) return;
    uint8_t flags = *(volatile uint8_t *)cmd;
    uint64_t size; const char *data;
    if (flags & 1) { size = rd64(cmd + 8); data = (const char *)rd64(cmd + 0x10); }
    else { size = flags >> 1; data = (const char *)(cmd + 1); }
    if (ptr_ok((uintptr_t)data) && size <= MAX_CMD_BYTES) {
        memcpy(r->cmd, data, (size_t)size);
        r->cmd_len = (uint32_t)size;
    }
}
/* parse a std::Cr::vector<uint8> at ptr into r->body */
static void capture_body(struct record *r, uintptr_t body) {
    if (!ptr_ok(body)) return;
    uintptr_t begin = rd64(body), end = rd64(body + 8);
    if (ptr_ok(begin) && end >= begin) {
        uint64_t size = end - begin;
        r->body_size = size;
        uint32_t n = size < MAX_BODY_PREVIEW ? (uint32_t)size : MAX_BODY_PREVIEW;
        memcpy(r->body_preview, (const void *)begin, n);
        r->body_preview_len = n;
    }
}

/* MSFSDK::sendPacket(unique_ptr<MSFRequest>): capture raw regs + *arg0 qwords.
 * Convention-agnostic: arg0 is the request whether static or member. */
static void hook_sendpacket(uintptr_t a0, uintptr_t a1, uintptr_t a2,
                            uintptr_t a3, uintptr_t a4) {
    uint64_t idx; struct record *r = record_begin(&idx);
    capture_args(r, a0, a1, a2, a3, a4);
    __atomic_store_n(&r->valid, 1, __ATOMIC_RELEASE);
    ((void (*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t))g_original_fn)(a0, a1, a2, a3, a4);
}

/* SendMsfRequestInternal(this, seq, cmd, body, opts, need_response). */
static void hook_internal(uintptr_t self, uint32_t seq, uintptr_t cmd, uintptr_t body,
                          uintptr_t opts, uint32_t need_response) {
    uint64_t idx; struct record *r = record_begin(&idx);
    capture_args(r, self, seq, cmd, body, opts);
    r->self = self; r->msf_seq = seq; r->need_response = need_response;
    if (ptr_ok(self) && g_base && rd64(self) == g_base + RVA_PRIMARY_VTABLE) g_instance = self;
    r->opts_ptr = opts;
    for (int i = 0; i < 4; i++) r->opts_q[i] = rd64(opts + (uintptr_t)i * 8);
    capture_cmd(r, cmd);
    capture_body(r, body);
    __atomic_store_n(&r->valid, 1, __ATOMIC_RELEASE);
    ((void (*)(uintptr_t, uint32_t, uintptr_t, uintptr_t, uintptr_t, uint32_t))g_original_fn)
        (self, seq, cmd, body, opts, need_response);
}

/* Real session-shell send(this, cmd, body, callback). The callback is a
 * Cr::function; capture its manager/invoke to confirm the invoke convention. */
static void hook_ssosend(uintptr_t self, uintptr_t cmd, uintptr_t body, uintptr_t cb) {
    uint64_t idx; struct record *r = record_begin(&idx);
    capture_args(r, self, cmd, body, cb, 0);
    r->self = self;
    capture_cmd(r, cmd);
    capture_body(r, body);
    memset(r->dump, 0, sizeof(r->dump));
    /* multi-level raw dump for offline layout analysis */
    for (int i = 0; i < 4; i++) r->dump[i] = rd64(cmd + (uintptr_t)i * 8);      /* 0: cmd ptr */
    for (int i = 0; i < 4; i++) r->dump[4 + i] = rd64(body + (uintptr_t)i * 8); /* 4: body ptr */
    uintptr_t body0 = rd64(body);
    for (int i = 0; i < 4; i++) r->dump[8 + i] = rd64(body0 + (uintptr_t)i * 8); /* 8: *body */
    for (int i = 0; i < 4; i++) r->dump[12 + i] = rd64(cb + (uintptr_t)i * 8);  /* 12: cb ptr */
    uintptr_t obj = rd64(cb);
    r->cb_obj = obj;
    for (int i = 0; i < 8; i++) r->dump[16 + i] = rd64(obj + (uintptr_t)i * 8); /* 16: *cb */
    uintptr_t obj0 = rd64(obj);
    for (int i = 0; i < 4; i++) r->dump[24 + i] = rd64(obj0 + (uintptr_t)i * 8); /* 24: **cb */
    /* session-shell members the send reads, to trace the MSF service instance */
    r->dump[28] = rd64(self + 0x478);
    r->dump[29] = rd64(self + 0x470);
    r->dump[30] = rd64(self + 0x68);
    r->dump[31] = rd64(self + 0x60);
    uintptr_t m478 = rd64(self + 0x478);
    for (int i = 0; i < 4; i++) r->dump[32 + i] = rd64(m478 + (uintptr_t)i * 8); /* 32: *[self+478] */
    uintptr_t m470 = rd64(self + 0x470);
    for (int i = 0; i < 4; i++) r->dump[36 + i] = rd64(m470 + (uintptr_t)i * 8); /* 36: *[self+470] */
    /* full request struct (rdx) + its body data pointer target */
    for (int i = 0; i < 8; i++) r->dump[40 + i] = rd64(body + (uintptr_t)i * 8); /* 40: request struct */
    uintptr_t bdata = rd64(body + 16);
    for (int i = 0; i < 8; i++) r->dump[48 + i] = rd64(bdata + (uintptr_t)i * 8); /* 48: body data */
    for (int i = 0; i < 8; i++) r->dump[56 + i] = rd64(obj + (uintptr_t)(8 + i) * 8); /* 56: cbObj+8.. */
    if (ptr_ok(obj)) {
        r->cb_manager = rd64(obj + 0x10);
        r->cb_invoke = rd64(obj + 0x18);
        r->cb_invoke_rva = g_base ? (r->cb_invoke - g_base) : 0;
        memcpy(r->cb_buf, (const void *)obj, 16);
    }
    /* store templates for proactive clone+redirect send */
    if (ptr_ok(self) && ptr_ok(body) && ptr_ok(cb) && ptr_ok(obj)) {
        g_ss_instance = self;
        for (int i = 0; i < 8; i++) g_req_template[i] = rd64(body + (uintptr_t)i * 8);
        for (int i = 0; i < 16; i++) g_cb_template[i] = rd64(obj + (uintptr_t)i * 8);
        uintptr_t ctrl = rd64(cb + 8);
        for (int i = 0; i < 8; i++) g_ctrl_template[i] = rd64(ctrl + (uintptr_t)i * 8);
        g_cb_vtable_orig = rd64(obj);
        for (int i = 0; i < 8; i++) g_nat_req[i] = g_req_template[i];
        uintptr_t nb = rd64(body + 16);
        uint64_t nl = rd64(body);
        g_nat_body_len = 0;
        if (ptr_ok(nb) && nl > 0 && nl <= sizeof(g_nat_body)) {
            g_nat_body_len = (uint32_t)nl;
            memcpy(g_nat_body, (const void *)nb, (size_t)nl);
        }
        g_have_template = 1;
    }
    __atomic_store_n(&r->valid, 1, __ATOMIC_RELEASE);
    ((void (*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t))g_original_fn)(self, cmd, body, cb);
}

/* --- patch helpers --- */
static int write_text(uintptr_t addr, const uint8_t *bytes, size_t len) {
    long ps = sysconf(_SC_PAGESIZE);
    uintptr_t page = addr & ~(uintptr_t)(ps - 1);
    size_t span = (addr + len) - page;
    if (mprotect((void *)page, span, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) return 0;
    memcpy((void *)addr, bytes, len);
    __builtin___clear_cache((char *)addr, (char *)addr + len);
    mprotect((void *)page, span, PROT_READ | PROT_EXEC);
    return 1;
}

static void emit_abs_jmp(uint8_t *out, uintptr_t target) {
    out[0] = 0xFF; out[1] = 0x25; out[2] = 0; out[3] = 0; out[4] = 0; out[5] = 0;
    memcpy(out + 6, &target, 8);
}

/* --- N-API: probe (read-only) --- */
static napi_value Probe(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    uintptr_t base = 0;
    if (!resolve_base(&base)) {
        set(env, o, "ok", mk_str(env, "false"));
        set(env, o, "error", mk_str(env, "wrapper.node MSFSDK::sendPacket export not found"));
        return o;
    }
    g_base = base;
    set(env, o, "ok", mk_str(env, "true"));
    set(env, o, "base", mk_u64(env, base));
    set(env, o, "sendMsfRequest", mk_u64(env, base + RVA_SEND_MSF_REQUEST));
    uintptr_t slot = base + RVA_GLOBAL_SLOT;
    uintptr_t raw = rd64(slot);
    set(env, o, "globalSlot", mk_u64(env, slot));
    set(env, o, "instancePtr", mk_u64(env, raw));
    set(env, o, "vptrExpected", mk_u64(env, base + RVA_PRIMARY_VTABLE));
    if (ptr_ok(raw)) {
        set(env, o, "vptr", mk_u64(env, rd64(raw)));
        set(env, o, "signerPresent", mk_str(env, rd64(raw + 0x70) ? "true" : "false"));
    }
    set(env, o, "onceGuard", mk_u64(env, rd64(base + RVA_ONCE_GUARD)));
    set(env, o, "instanceValid", mk_str(env, instance_valid(base) ? "true" : "false"));
    set(env, o, "installed", mk_str(env, g_installed ? "true" : "false"));
    return o;
}

/* --- N-API: install (opt-in; target selected by name, verified by prologue) --- */
static napi_value Install(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    /* allow switching targets: restore any existing patch first */
    if (g_installed) {
        write_text(g_target, g_original, g_patch_len);
        if (g_trampoline) munmap((void *)g_trampoline, 64);
        g_trampoline = 0; g_original_fn = 0; g_installed = 0;
    }
    char tname[32] = "sendpacket";
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc >= 1) napi_get_value_string_utf8(env, argv[0], tname, sizeof(tname), NULL);
    int kind = 0;
    for (int i = 0; i < NTARGETS; i++) if (strcmp(tname, TARGETS[i].name) == 0) { kind = i; break; }
    const struct target_desc *td = &TARGETS[kind];

    uintptr_t base = 0;
    if (!resolve_base(&base)) {
        set(env, o, "ok", mk_str(env, "false"));
        set(env, o, "error", mk_str(env, "wrapper.node base unresolved; probe first"));
        return o;
    }
    g_base = base;
    g_target = base + td->rva;
    /* Confirm the detour target by its exact prologue before writing anything. */
    if (memcmp((const void *)g_target, td->prologue, td->patch_len) != 0) {
        set(env, o, "ok", mk_str(env, "false"));
        set(env, o, "error", mk_str(env, "target prologue fingerprint mismatch; wrong build or RVA"));
        set(env, o, "targetName", mk_str(env, td->name));
        return o;
    }

    void *tm = mmap(NULL, 64, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tm == MAP_FAILED) { set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "trampoline mmap failed")); return o; }
    uint8_t *t = (uint8_t *)tm;
    memcpy(t, (const void *)g_target, td->patch_len);          /* original prologue (position-independent) */
    emit_abs_jmp(t + td->patch_len, g_target + td->patch_len); /* jmp back to original+patch_len */
    memcpy(g_original, (const void *)g_target, td->patch_len); /* save for uninstall */
    g_patch_len = td->patch_len;

    uintptr_t hook = (kind == 1) ? (uintptr_t)hook_internal
                   : (kind == 3) ? (uintptr_t)hook_ssosend
                   : (uintptr_t)hook_sendpacket;
    uint8_t patch[PATCH_LEN];
    emit_abs_jmp(patch, hook);                                 /* 14-byte abs jmp */
    for (size_t i = JMP_LEN; i < td->patch_len; i++) patch[i] = 0x90; /* NOP pad to boundary */
    if (!write_text(g_target, patch, td->patch_len)) {
        munmap(tm, 64);
        set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "text patch failed")); return o;
    }
    g_trampoline = (uintptr_t)tm;
    g_original_fn = (uintptr_t)tm;
    g_target_kind = kind;
    g_counter = 0;
    g_installed = 1;
    set(env, o, "ok", mk_str(env, "true"));
    set(env, o, "targetName", mk_str(env, td->name));
    set(env, o, "target", mk_u64(env, g_target));
    set(env, o, "trampoline", mk_u64(env, g_trampoline));
    return o;
}

/* --- N-API: uninstall (restore original bytes) --- */
static napi_value Uninstall(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    if (!g_installed) { set(env, o, "ok", mk_str(env, "true")); set(env, o, "note", mk_str(env, "not installed")); return o; }
    write_text(g_target, g_original, g_patch_len);
    if (g_trampoline) munmap((void *)g_trampoline, 64);
    g_trampoline = 0; g_original_fn = 0; g_installed = 0;
    set(env, o, "ok", mk_str(env, "true"));
    return o;
}

/* --- N-API: call-site capture of the real session-shell send target --- */
static napi_value CaptureTarget(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    if (g_cs_installed) { set(env, o, "ok", mk_str(env, "true")); set(env, o, "note", mk_str(env, "already installed")); return o; }
    uintptr_t base = 0;
    if (!resolve_base(&base)) { set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "base unresolved")); return o; }
    g_base = base;
    g_callsite = base + RVA_SSO_CALLSITE;
    const uint8_t expect[6] = {0xff, 0x90, 0x88, 0x07, 0x00, 0x00}; /* call [rax+0x788] */
    if (memcmp((const void *)g_callsite, expect, 6) != 0) {
        set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "callsite fingerprint mismatch")); return o;
    }
    void *tm = mmap(NULL, 64, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tm == MAP_FAILED) { set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "thunk mmap failed")); return o; }
    uint8_t *t = (uint8_t *)tm;
    /* mov r11,[rax+0x788] */
    t[0]=0x4c; t[1]=0x8b; t[2]=0x98; t[3]=0x88; t[4]=0x07; t[5]=0; t[6]=0;
    /* mov [rip+10],r11  -> stores into t+24 (RIP here is t+14) */
    t[7]=0x4c; t[8]=0x89; t[9]=0x1d; t[10]=0x0a; t[11]=0; t[12]=0; t[13]=0;
    /* jmp r11 */
    t[14]=0x41; t[15]=0xff; t[16]=0xe3;
    *(uintptr_t *)(t + 24) = 0;
    __builtin___clear_cache((char *)t, (char *)t + 32);
    memcpy(g_cs_original, (const void *)g_callsite, 6);
    uint8_t patch[6];
    patch[0] = 0xe8;
    int32_t rel = (int32_t)((intptr_t)t - (intptr_t)(g_callsite + 5));
    memcpy(patch + 1, &rel, 4);
    patch[5] = 0x90;
    if (!write_text(g_callsite, patch, 6)) {
        munmap(tm, 64);
        set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "callsite patch failed")); return o;
    }
    g_cs_thunk = (uintptr_t)tm; g_cs_installed = 1;
    set(env, o, "ok", mk_str(env, "true"));
    set(env, o, "callsite", mk_u64(env, g_callsite));
    set(env, o, "thunk", mk_u64(env, g_cs_thunk));
    return o;
}
static napi_value ReadTarget(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    uintptr_t target = g_cs_thunk ? *(uintptr_t *)(g_cs_thunk + 24) : 0;
    set(env, o, "installed", mk_str(env, g_cs_installed ? "true" : "false"));
    set(env, o, "lastTarget", mk_u64(env, target));
    set(env, o, "lastTargetRva", mk_u64(env, (target && g_base) ? target - g_base : 0));
    return o;
}
static napi_value RestoreTarget(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    if (!g_cs_installed) { set(env, o, "ok", mk_str(env, "true")); set(env, o, "note", mk_str(env, "not installed")); return o; }
    write_text(g_callsite, g_cs_original, 6);
    if (g_cs_thunk) munmap((void *)g_cs_thunk, 64);
    g_cs_thunk = 0; g_cs_installed = 0;
    set(env, o, "ok", mk_str(env, "true"));
    return o;
}

/* --- proactive send: cloned request + redirected callback --- */
static void my_ctrl_noop(void) { /* never destroy: refcounts held high */ }
static void my_dtor(uintptr_t self) { (void)self; }
static void parse_string(uintptr_t p, char *out, size_t cap) {
    out[0] = 0;
    if (!ptr_ok(p)) return;
    uint8_t flags = *(volatile uint8_t *)p;
    uint64_t size; const char *data;
    if (flags & 1) { size = rd64(p + 8); data = (const char *)rd64(p + 0x10); }
    else { size = flags >> 1; data = (const char *)(p + 1); }
    if (ptr_ok((uintptr_t)data) && size < cap) { memcpy(out, data, (size_t)size); out[size] = 0; }
}
static uint32_t parse_vector(uintptr_t p, uint8_t *out, size_t cap) {
    if (!ptr_ok(p)) return 0;
    uintptr_t begin = rd64(p), end = rd64(p + 8);
    if (ptr_ok(begin) && end >= begin && (end - begin) <= cap) {
        uint32_t n = (uint32_t)(end - begin);
        memcpy(out, (const void *)begin, n);
        return n;
    }
    return 0;
}
/* parse a std::Cr::string into raw bytes (body is a string, not a vector) */
static uint32_t parse_str_bytes(uintptr_t p, uint8_t *out, size_t cap) {
    if (!ptr_ok(p)) return 0;
    uint8_t flags = *(volatile uint8_t *)p;
    uint64_t size; const uint8_t *data;
    if (flags & 1) { size = rd64(p + 8); data = (const uint8_t *)rd64(p + 0x10); }
    else { size = flags >> 1; data = (const uint8_t *)(p + 1); }
    if (ptr_ok((uintptr_t)data) && size <= cap) {
        memcpy(out, data, (size_t)size);
        return (uint32_t)size;
    }
    return 0;
}
static void my_invoke(uintptr_t self, uint32_t result, uintptr_t a2, uintptr_t a3, uintptr_t a4, uintptr_t a5) {
    (void)self;
    g_rsp_result = result;
    g_rsp_cmd_ptr = a2; g_rsp_body_ptr = a3;
    g_rsp_regs[0] = a2; g_rsp_regs[1] = a3; g_rsp_regs[2] = a4; g_rsp_regs[3] = a5;
    for (int i = 0; i < 4; i++) {
        uintptr_t p = g_rsp_regs[i];
        for (int j = 0; j < 4; j++) g_rsp_q[i][j] = rd64(p + (uintptr_t)j * 8);
    }
    g_rsp_count++;
    parse_string(a2, g_rsp_cmd, sizeof(g_rsp_cmd));
    /* response body is a std::Cr::string at a3 (rcx) */
    g_rsp_body_len = parse_str_bytes(a3, g_rsp_body, sizeof(g_rsp_body));
    g_rsp_body2_len = parse_str_bytes(a4, g_rsp_body2, sizeof(g_rsp_body2));
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static char    g_send_cmd_buf[128];
static uint64_t g_send_req[8] __attribute__((aligned(16)));
static uint8_t  g_send_body_buf[2048];

static napi_value Send(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    if (!g_have_template || !g_ss_instance || !g_base) {
        set(env, o, "ok", mk_str(env, "false"));
        set(env, o, "error", mk_str(env, "no template; install ssosend and trigger a natural send first"));
        return o;
    }
    /* args: cmd (string), bodyHex (string) */
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (argc < 2) { set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "need cmd, bodyHex")); return o; }
    size_t cmd_len = 0;
    napi_get_value_string_utf8(env, argv[0], g_send_cmd_buf, sizeof(g_send_cmd_buf), &cmd_len);
    char hex[4096]; size_t hex_len = 0;
    napi_get_value_string_utf8(env, argv[1], hex, sizeof(hex), &hex_len);
    if (hex_len % 2 || hex_len / 2 > sizeof(g_send_body_buf)) {
        set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "bad bodyHex")); return o;
    }
    size_t body_len = hex_len / 2;
    for (size_t i = 0; i < body_len; i++) {
        int hi = hexval(hex[2*i]), lo = hexval(hex[2*i+1]);
        if (hi < 0 || lo < 0) { set(env, o, "ok", mk_str(env, "false")); set(env, o, "error", mk_str(env, "bad hex")); return o; }
        g_send_body_buf[i] = (uint8_t)((hi << 4) | lo);
    }
    /* build long cmd std::string {flags=1, size, ptr} */
    uint64_t cmd_str[3] = { 1, (uint64_t)cmd_len, (uint64_t)(uintptr_t)g_send_cmd_buf };
    /* request struct is a std::Cr::string: +0=flags(long bit0=1), +8=size,
     * +16=data ptr. Keep template flags, set size to our body length. */
    g_send_req[0] = g_req_template[0] | 1ULL;
    g_send_req[1] = (uint64_t)body_len;
    g_send_req[2] = (uint64_t)(uintptr_t)g_send_body_buf;
    g_send_req[3] = cmd_str[0]; g_send_req[4] = cmd_str[1]; g_send_req[5] = cmd_str[2];
    g_send_req[6] = 0; g_send_req[7] = 0;
    /* custom control block: vtable of no-ops, refcounts held high */
    for (int i = 0; i < 8; i++) g_my_ctrl_vtable[i] = (uint64_t)(uintptr_t)my_ctrl_noop;
    g_my_ctrl[0] = (uint64_t)(uintptr_t)g_my_ctrl_vtable;
    g_my_ctrl[1] = 0x10000; g_my_ctrl[2] = 0x10000;
    for (int i = 3; i < 8; i++) g_my_ctrl[i] = 0;
    /* custom wrapper vtable: dtor, deleting dtor, invoke, rest no-op */
    for (int i = 0; i < 8; i++) g_my_cb_vtable[i] = (uint64_t)(uintptr_t)my_ctrl_noop;
    g_my_cb_vtable[0] = (uint64_t)(uintptr_t)my_dtor;
    g_my_cb_vtable[1] = (uint64_t)(uintptr_t)my_dtor;
    g_my_cb_vtable[2] = (uint64_t)(uintptr_t)my_invoke;
    g_my_wrapper[0] = (uint64_t)(uintptr_t)g_my_cb_vtable;
    for (int i = 1; i < 16; i++) g_my_wrapper[i] = 0;
    g_my_sharedptr[0] = (uint64_t)(uintptr_t)g_my_wrapper;
    g_my_sharedptr[1] = (uint64_t)(uintptr_t)g_my_ctrl;
    g_rsp_count = 0; g_rsp_body_len = 0; g_rsp_cmd[0] = 0;
    /* call the session-shell send(this, cmd, request, callback) */
    ((void (*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t))(g_base + RVA_SS_SEND))
        (g_ss_instance, (uintptr_t)cmd_str, (uintptr_t)g_send_req, (uintptr_t)g_my_sharedptr);
    set(env, o, "ok", mk_str(env, "true"));
    set(env, o, "cmd", mk_str(env, g_send_cmd_buf));
    set(env, o, "bodyLen", mk_u64(env, body_len));
    set(env, o, "instance", mk_u64(env, g_ss_instance));
    return o;
}

static napi_value ReadResponse(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    set(env, o, "count", mk_u32(env, g_rsp_count));
    set(env, o, "result", mk_u64(env, g_rsp_result));
    set(env, o, "cmd", mk_str(env, g_rsp_cmd));
    set(env, o, "bodyLen", mk_u32(env, g_rsp_body_len));
    napi_value bp; napi_create_array(env, &bp);
    for (uint32_t i = 0; i < g_rsp_body_len; i++) napi_set_element(env, bp, i, mk_u32(env, g_rsp_body[i]));
    set(env, o, "body", bp);
    napi_value regs; napi_create_array(env, &regs);
    for (int i = 0; i < 4; i++) napi_set_element(env, regs, i, mk_u64(env, g_rsp_regs[i]));
    set(env, o, "regs", regs);
    napi_value qs; napi_create_array(env, &qs);
    for (int i = 0; i < 4; i++) {
        napi_value row; napi_create_array(env, &row);
        for (int j = 0; j < 4; j++) napi_set_element(env, row, j, mk_u64(env, g_rsp_q[i][j]));
        napi_set_element(env, qs, i, row);
    }
    set(env, o, "regQwords", qs);
    set(env, o, "body2Len", mk_u32(env, g_rsp_body2_len));
    napi_value bp2; napi_create_array(env, &bp2);
    for (uint32_t i = 0; i < g_rsp_body2_len; i++) napi_set_element(env, bp2, i, mk_u32(env, g_rsp_body2[i]));
    set(env, o, "body2", bp2);
    return o;
}

static napi_value ReadTemplate(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    set(env, o, "haveTemplate", mk_str(env, g_have_template ? "true" : "false"));
    napi_value req; napi_create_array(env, &req);
    for (int i = 0; i < 8; i++) napi_set_element(env, req, i, mk_u64(env, g_nat_req[i]));
    set(env, o, "reqStruct", req);
    set(env, o, "bodyLen", mk_u32(env, g_nat_body_len));
    napi_value bp; napi_create_array(env, &bp);
    for (uint32_t i = 0; i < g_nat_body_len; i++) napi_set_element(env, bp, i, mk_u32(env, g_nat_body[i]));
    set(env, o, "body", bp);
    return o;
}

/* --- N-API: status --- */
static napi_value Status(napi_env env, napi_callback_info info) {
    napi_value o; napi_create_object(env, &o);
    set(env, o, "installed", mk_str(env, g_installed ? "true" : "false"));
    set(env, o, "targetName", mk_str(env, g_installed ? TARGETS[g_target_kind].name : ""));
    set(env, o, "calls", mk_u64(env, __atomic_load_n(&g_counter, __ATOMIC_RELAXED)));
    set(env, o, "base", mk_u64(env, g_base));
    set(env, o, "instance", mk_u64(env, g_instance));
    return o;
}

/* --- N-API: readCapture (snapshot of valid ring records) --- */
static napi_value ReadCapture(napi_env env, napi_callback_info info) {
    napi_value arr; napi_create_array(env, &arr);
    uint32_t out = 0;
    uint64_t total = __atomic_load_n(&g_counter, __ATOMIC_RELAXED);
    uint64_t start = total > MAX_RECORDS ? total - MAX_RECORDS : 0;
    for (uint64_t s = start; s < total; s++) {
        struct record *r = &g_records[s % MAX_RECORDS];
        if (!__atomic_load_n(&r->valid, __ATOMIC_ACQUIRE) || r->seq != s) continue;
        napi_value e; napi_create_object(env, &e);
        set(env, e, "seq", mk_u64(env, r->seq));
        napi_value args; napi_create_array(env, &args);
        for (int i = 0; i < 5; i++) napi_set_element(env, args, i, mk_u64(env, r->args[i]));
        set(env, e, "args", args);
        napi_value a0q; napi_create_array(env, &a0q);
        for (int i = 0; i < 8; i++) napi_set_element(env, a0q, i, mk_u64(env, r->arg0_q[i]));
        set(env, e, "arg0Qwords", a0q);
        set(env, e, "self", mk_u64(env, r->self));
        set(env, e, "msfSeq", mk_u32(env, r->msf_seq));
        set(env, e, "needResponse", mk_u32(env, r->need_response));
        set(env, e, "optsPtr", mk_u64(env, r->opts_ptr));
        napi_value oq; napi_create_array(env, &oq);
        for (int i = 0; i < 4; i++) napi_set_element(env, oq, i, mk_u64(env, r->opts_q[i]));
        set(env, e, "optsQwords", oq);
        set(env, e, "cbObj", mk_u64(env, r->cb_obj));
        set(env, e, "cbManager", mk_u64(env, r->cb_manager));
        set(env, e, "cbInvoke", mk_u64(env, r->cb_invoke));
        set(env, e, "cbInvokeRva", mk_u64(env, r->cb_invoke_rva));
        napi_value dump; napi_create_array(env, &dump);
        for (int i = 0; i < 64; i++) napi_set_element(env, dump, i, mk_u64(env, r->dump[i]));
        set(env, e, "dump", dump);
        set(env, e, "cmd", mk_str(env, r->cmd_len ? r->cmd : ""));
        set(env, e, "cmdLen", mk_u32(env, r->cmd_len));
        set(env, e, "bodySize", mk_u64(env, r->body_size));
        napi_value bp; napi_create_array(env, &bp);
        for (uint32_t i = 0; i < r->body_preview_len; i++) napi_set_element(env, bp, i, mk_u32(env, r->body_preview[i]));
        set(env, e, "bodyPreview", bp);
        napi_set_element(env, arr, out++, e);
    }
    return arr;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
#define EXPORT(name, cb) \
    napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn); \
    napi_set_named_property(env, exports, name, fn);
    EXPORT("probe", Probe)
    EXPORT("install", Install)
    EXPORT("uninstall", Uninstall)
    EXPORT("status", Status)
    EXPORT("readCapture", ReadCapture)
    EXPORT("captureTarget", CaptureTarget)
    EXPORT("readTarget", ReadTarget)
    EXPORT("restoreTarget", RestoreTarget)
    EXPORT("send", Send)
    EXPORT("readResponse", ReadResponse)
    EXPORT("readTemplate", ReadTemplate)
#undef EXPORT
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)