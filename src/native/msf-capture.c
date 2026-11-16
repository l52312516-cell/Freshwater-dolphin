/* Fixed QQ 3.2.35-54395 Linux x64 session-shell MSF adapter (N-API 8).
 * The checked 17-byte entry prologue is the only QQ code patch. Requests have
 * independent shared callback ownership and immutable IDs. Retired callbacks
 * cannot overwrite the current response. No protocol payloads are logged.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <link.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stddef.h>
#include <stdio.h>

#define SEND_RVA 0x2f4e4b0ULL
#define PATCH_LEN 17
#define MAX_BODY 65536
#define MAX_FACE_RESPONSE_BODY 262144
#define MAX_LIVE 64
static const uint8_t PROLOGUE[PATCH_LEN] = {0x55,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec,0x78,0x01,0x00,0x00};
/* Pin the callback ownership contract as well as the entry prologue: the callee
 * reads the input pair and increments a copy; its original caller releases its
 * own argument after return. A matching function entry alone is insufficient. */
static const uint8_t CALLBACK_COPY[] = {0x49,0x8b,0x45,0x00,0x48,0x89,0x84,0x24,0x00,0x01,0x00,0x00,
    0x49,0x8b,0x45,0x08,0x48,0x89,0x84,0x24,0x08,0x01,0x00,0x00,0x48,0x85,0xc0,0x74,0x05,0xf0,0x48,0xff,0x40,0x08};
static const uint8_t CALLER_RELEASE[] = {0x48,0x8b,0x5c,0x24,0x40,0x48,0x85,0xdb,0x74,0x23,
    0x48,0xc7,0xc0,0xff,0xff,0xff,0xff,0xf0,0x48,0x0f,0xc1,0x43,0x08};
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static uintptr_t base, original_fn, instance;
static uint8_t saved[PATCH_LEN];
static int installed, have_template;
static uint64_t next_id, live_requests;
static struct { uintptr_t begin, end; } readable[32];
static size_t readable_count;
static int protection_failed;

struct request;
/* libc++ __shared_weak_count ABI: vptr, shared owners minus one, weak owners
 * minus one. One native reference is retained until read/cancellation retires it;
 * QQ owns its copied shared_ptr until its callback is released. */
struct control { uintptr_t *vtable; int64_t strong, weak; struct request *owner; };
struct request {
    uintptr_t wrapper[16];
    struct control control;
    uintptr_t shared[2];
    uint64_t id;
    int cancelled, complete;
    uint32_t result, body_len, body_status, response_limit;
    uint64_t response_size;
    uint64_t command_string[3], request_string[8];
    char command[128];
    uint8_t request_body[MAX_BODY];
    uint8_t *response_body;
};
static struct request *active;
static napi_value str(napi_env e,const char *s) { napi_value v; napi_create_string_utf8(e,s,NAPI_AUTO_LENGTH,&v); return v; }
static napi_value num(napi_env e,uint32_t n) { napi_value v; napi_create_uint32(e,n,&v); return v; }
static void set(napi_env e,napi_value o,const char *k,napi_value v) { napi_set_named_property(e,o,k,v); }
static napi_value object(napi_env e) { napi_value v; napi_create_object(e,&v); return v; }
static napi_value fail(napi_env e,const char *s) { napi_value o=object(e);set(e,o,"ok",str(e,"false"));set(e,o,"error",str(e,s));return o; }
static napi_value id_value(napi_env e,uint64_t id) { char b[32];snprintf(b,sizeof(b),"%llu",(unsigned long long)id);return str(e,b); }
static uint64_t id_arg(napi_env e,napi_callback_info info) {
    napi_value a[1];size_t n=1,len=0;char b[32]={0};napi_get_cb_info(e,info,&n,a,NULL,NULL);
    if(n!=1||napi_get_value_string_utf8(e,a[0],b,sizeof(b),&len)!=napi_ok||!len||len>=sizeof(b)-1)return 0;
    for(size_t i=0;i<len;i++)if(b[i]<'0'||b[i]>'9')return 0;
    return strtoull(b,NULL,10);
}
static void noop(void *p) { (void)p; }
static void *no_deleter(void *p,void *t) { (void)p;(void)t;return NULL; }
static void destroy_control(struct control *c) { __atomic_sub_fetch(&live_requests,1,__ATOMIC_RELAXED);free(c->owner->response_body);free(c->owner); }
static uintptr_t control_vtable[5]={(uintptr_t)noop,(uintptr_t)noop,(uintptr_t)noop,(uintptr_t)no_deleter,(uintptr_t)destroy_control};
static void release_control(struct control *c) {
    if(__atomic_fetch_sub(&c->strong,1,__ATOMIC_ACQ_REL)==0) {
        /* __on_zero_shared is a no-op: request storage is owned by the control
         * block until the final weak reference is gone. */
        if(__atomic_fetch_sub(&c->weak,1,__ATOMIC_ACQ_REL)==0)destroy_control(c);
    }
}
static int valid_ptr(uintptr_t p) { return p>=0x10000 && p<0x0000800000000000ULL; }
static uint32_t string_bytes(uintptr_t p,uint8_t **out,uint32_t limit,uint64_t *reported,uint32_t *status) {
    *reported=0;*status=3;
    if(!valid_ptr(p))return 0;
    uint8_t flags=*(const uint8_t *)p;uint64_t size;const uint8_t *data;
    if(flags&1){memcpy(&size,(void *)(p+8),8);memcpy(&data,(void *)(p+16),8);}
    else {size=flags>>1;data=(const uint8_t *)(p+1);}
    *reported=size;
    if(size>limit){*status=2;return 0;}
    if(!size){*status=0;return 0;}
    if(!valid_ptr((uintptr_t)data))return 0;
    uint8_t *copy=malloc((size_t)size);if(!copy){*status=4;return 0;}
    memcpy(copy,data,(size_t)size);*out=copy;*status=1;return (uint32_t)size;
}
static void invoke(struct request *r,uint32_t result,uintptr_t msg,uintptr_t body,uintptr_t a4,uintptr_t a5) {
    (void)msg;(void)a4;(void)a5;
    pthread_mutex_lock(&mutex);
    if(!r->cancelled&&!r->complete){r->result=result;r->body_len=string_bytes(body,&r->response_body,r->response_limit,&r->response_size,&r->body_status);r->complete=1;}
    pthread_mutex_unlock(&mutex);
}
static uintptr_t callback_vtable[3]={(uintptr_t)noop,(uintptr_t)noop,(uintptr_t)invoke};
static void retire(void) {
    pthread_mutex_lock(&mutex);struct request *r=active;active=NULL;if(r)r->cancelled=1;pthread_mutex_unlock(&mutex);
    if(r)release_control(&r->control);
}
static int find_wrapper(struct dl_phdr_info *i,size_t size,void *out) {
    (void)size;const char *name=i->dlpi_name,*slash=name?strrchr(name,'/'):NULL;
    if(name&&strcmp(slash?slash+1:name,"wrapper.node")==0){
        readable_count=0;
        for(size_t p=0;p<i->dlpi_phnum;p++) {
            const ElfW(Phdr) *h=&i->dlpi_phdr[p];
            if(h->p_type!=PT_LOAD||!(h->p_flags&PF_R)||readable_count>=32)continue;
            uintptr_t begin=i->dlpi_addr+h->p_vaddr,end=begin+h->p_memsz;
            if(end>=begin){readable[readable_count].begin=begin;readable[readable_count++].end=end;}
        }
        *(uintptr_t *)out=i->dlpi_addr;return 1;
    }return 0;
}
static int mapped_readable(uintptr_t address,size_t length) {
    if(address+length<address)return 0;
    for(size_t p=0;p<readable_count;p++)if(address>=readable[p].begin&&address+length<=readable[p].end)return 1;
    return 0;
}
static void hooked_send(uintptr_t self,uintptr_t cmd,uintptr_t req,uintptr_t cb) {
    pthread_mutex_lock(&mutex);instance=self;have_template=1;pthread_mutex_unlock(&mutex);
    ((void (*)(uintptr_t,uintptr_t,uintptr_t,uintptr_t))original_fn)(self,cmd,req,cb);
}
static void jump(uint8_t *p,uintptr_t addr){p[0]=0xff;p[1]=0x25;memset(p+2,0,4);memcpy(p+6,&addr,8);}
static int verified_target(void) {
    if(protection_failed)return 0;
    if(installed)return 1;
    base=0;readable_count=0;dl_iterate_phdr(find_wrapper,&base);if(!base)return 0;
    uintptr_t target=base+SEND_RVA;
    return mapped_readable(target,PATCH_LEN)&&mapped_readable(base+0x2f4e5f5ULL,sizeof(CALLBACK_COPY))&&
        mapped_readable(base+0x39e45cdULL,sizeof(CALLER_RELEASE))&&
        !memcmp((void *)target,PROLOGUE,PATCH_LEN)&&
        !memcmp((void *)(base+0x2f4e5f5ULL),CALLBACK_COPY,sizeof(CALLBACK_COPY))&&
        !memcmp((void *)(base+0x39e45cdULL),CALLER_RELEASE,sizeof(CALLER_RELEASE));
}
static napi_value Verify(napi_env e,napi_callback_info info) {
    (void)info;napi_value o=object(e);set(e,o,"ok",str(e,verified_target()?"true":"false"));return o;
}
static napi_value Install(napi_env e,napi_callback_info info) {
    (void)info;napi_value o=object(e);
    if(protection_failed)return fail(e,"Native target protection could not be restored; restart QQ");
    if(installed){set(e,o,"ok",str(e,"true"));return o;}
    if(!verified_target())return fail(e,"QQ native target, mapped ranges or callback ownership fingerprint mismatch");
    uintptr_t target=base+SEND_RVA;
    void *tr=mmap(NULL,64,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(tr==MAP_FAILED)return fail(e,"Native trampoline allocation failed");
    memcpy(saved,(void *)target,PATCH_LEN);memcpy(tr,saved,PATCH_LEN);jump((uint8_t *)tr+PATCH_LEN,target+PATCH_LEN);
    __builtin___clear_cache((char *)tr,(char *)tr+64);
    if(mprotect(tr,64,PROT_READ|PROT_EXEC)){munmap(tr,64);return fail(e,"Native trampoline protection change failed");}
    long ps=sysconf(_SC_PAGESIZE);uintptr_t page=target&~(uintptr_t)(ps-1);size_t span=target+PATCH_LEN-page;
    if(mprotect((void *)page,span,PROT_READ|PROT_WRITE|PROT_EXEC)){munmap(tr,64);return fail(e,"Native target protection change failed");}
    original_fn=(uintptr_t)tr;
    uint8_t patch[PATCH_LEN];memset(patch,0x90,sizeof(patch));jump(patch,(uintptr_t)hooked_send);memcpy((void *)target,patch,PATCH_LEN);
    __builtin___clear_cache((char *)target,(char *)target+PATCH_LEN);
    if(mprotect((void *)page,span,PROT_READ|PROT_EXEC)){installed=1;protection_failed=1;return fail(e,"Native target protection could not be restored; restart QQ");}
    installed=1;set(e,o,"ok",str(e,"true"));return o;
}
static napi_value Reset(napi_env e,napi_callback_info info){(void)info;retire();pthread_mutex_lock(&mutex);have_template=0;instance=0;pthread_mutex_unlock(&mutex);return object(e);}
static napi_value Template(napi_env e,napi_callback_info info){(void)info;napi_value o=object(e);pthread_mutex_lock(&mutex);set(e,o,"haveTemplate",str(e,have_template?"true":"false"));pthread_mutex_unlock(&mutex);return o;}
static int hex(char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;}
static napi_value Send(napi_env e,napi_callback_info info) {
    if(active)return fail(e,"Native request already active");
    if(__atomic_load_n(&live_requests,__ATOMIC_RELAXED)>=MAX_LIVE)return fail(e,"Native callback retention limit reached");
    pthread_mutex_lock(&mutex);uintptr_t self=instance;int captured=have_template;pthread_mutex_unlock(&mutex);
    if(!captured||!self||!base)return fail(e,"Native session not captured");
    napi_value a[2];size_t n=2,cl=0,hl=0;napi_get_cb_info(e,info,&n,a,NULL,NULL);
    if(n!=2||napi_get_value_string_utf8(e,a[0],NULL,0,&cl)!=napi_ok||!cl||cl>=128||napi_get_value_string_utf8(e,a[1],NULL,0,&hl)!=napi_ok||!hl||hl%2||hl>MAX_BODY*2)return fail(e,"Invalid native request arguments");
    struct request *r=calloc(1,sizeof(*r));char *h=malloc(hl+1);if(!r||!h){free(r);free(h);return fail(e,"Native request allocation failed");}
    napi_get_value_string_utf8(e,a[0],r->command,sizeof(r->command),&cl);napi_get_value_string_utf8(e,a[1],h,hl+1,&hl);
    /* Only the verified whole system-face directory needs a larger reply.
     * Request bytes and every other command retain the original 64 KiB bound;
     * response storage is allocated on completion, not per retained callback. */
    r->response_limit=strcmp(r->command,"OidbSvcTrpcTcp.0x9154_1")==0?MAX_FACE_RESPONSE_BODY:MAX_BODY;
    for(size_t i=0;i<hl/2;i++){int x=hex(h[i*2]),y=hex(h[i*2+1]);if(x<0||y<0){free(h);free(r);return fail(e,"Invalid native body encoding");}r->request_body[i]=(uint8_t)((x<<4)|y);}free(h);
    r->id=++next_id;if(!r->id)r->id=++next_id;
    r->wrapper[0]=(uintptr_t)callback_vtable;r->control.vtable=control_vtable;r->control.owner=r;
    r->shared[0]=(uintptr_t)r->wrapper;r->shared[1]=(uintptr_t)&r->control;
    r->command_string[0]=1;r->command_string[1]=cl;r->command_string[2]=(uintptr_t)r->command;
    r->request_string[0]=1;r->request_string[1]=hl/2;r->request_string[2]=(uintptr_t)r->request_body;
    memcpy(r->request_string+3,r->command_string,sizeof(r->command_string));
    __atomic_add_fetch(&live_requests,1,__ATOMIC_RELAXED);
    pthread_mutex_lock(&mutex);active=r;pthread_mutex_unlock(&mutex);
    /* Match QQ's checked caller: retain a separate argument reference, let the
     * callee copy it, then release our argument. The native handle stays alive
     * until release(), independently of QQ's asynchronous callback lifetime. */
    __atomic_add_fetch(&r->control.strong,1,__ATOMIC_RELAXED);
    ((void (*)(uintptr_t,uintptr_t,uintptr_t,uintptr_t))(base+SEND_RVA))(self,(uintptr_t)r->command_string,(uintptr_t)r->request_string,(uintptr_t)r->shared);
    r->shared[0]=0;r->shared[1]=0;release_control(&r->control);
    napi_value o=object(e);set(e,o,"ok",str(e,"true"));set(e,o,"requestId",id_value(e,r->id));return o;
}
static napi_value Read(napi_env e,napi_callback_info info) {
    uint64_t id=id_arg(e,info);napi_value o=object(e);
    pthread_mutex_lock(&mutex);struct request *r=active;
    if(!id||!r||r->id!=id){pthread_mutex_unlock(&mutex);set(e,o,"requestId",str(e,"0"));return o;}
    set(e,o,"requestId",id_value(e,id));set(e,o,"count",num(e,r->complete?1:0));set(e,o,"result",num(e,r->result));
    set(e,o,"responseBytes",id_value(e,r->response_size));
    set(e,o,"bodyStatus",str(e,r->body_status==0?"empty":r->body_status==1?"copied":r->body_status==2?"too_large":r->body_status==4?"allocation_failed":"invalid"));
    napi_value b;napi_create_buffer_copy(e,r->body_len,r->response_body,NULL,&b);set(e,o,"body",b);
    pthread_mutex_unlock(&mutex);return o;
}
static napi_value Release(napi_env e,napi_callback_info info) {
    uint64_t id=id_arg(e,info);pthread_mutex_lock(&mutex);struct request *r=active;
    if(r&&r->id==id){active=NULL;r->cancelled=1;}else r=NULL;pthread_mutex_unlock(&mutex);
    if(r)release_control(&r->control);
    return object(e);
}
static napi_value Status(napi_env e,napi_callback_info info) {
    (void)info;napi_value o=object(e);set(e,o,"installed",num(e,installed));set(e,o,"liveRequests",num(e,(uint32_t)__atomic_load_n(&live_requests,__ATOMIC_RELAXED)));return o;
}
static napi_value Init(napi_env e,napi_value exports) {
    napi_value fn;
#define EXPORT(name,cb) napi_create_function(e,name,NAPI_AUTO_LENGTH,cb,NULL,&fn);napi_set_named_property(e,exports,name,fn);
    EXPORT("verifyTarget",Verify) EXPORT("install",Install) EXPORT("resetSession",Reset) EXPORT("readTemplate",Template)
    EXPORT("send",Send) EXPORT("readResponse",Read) EXPORT("release",Release) EXPORT("status",Status)
    set(e,exports,"protocolVersion",num(e,2));return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
