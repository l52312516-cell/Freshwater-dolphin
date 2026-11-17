---
applyTo: "src/qq/**,src/onebot/**,src/ipc/**,src/message-log.cjs,tests/**"
excludeAgent: "cloud-agent"
---

Review QQ and OneBot changes for real contract mismatches, not just method names. Follow message IDs, peer identity, account namespace, segment conversion, storage, and send/forward/download results through their consumers.

Prioritize regressions that mix accounts, fabricate success, lose supported messages, expose credentials/private content, or permit incompatible native calls. Reads can return supported content with an explicit partial diagnostic; outgoing validation must reject missing/conflicting identity and unsupported payloads before writing. Temporary unavailability is distinct from an invalid identity. Preserve the original remote error and diagnostic reason without dumping raw private payloads.

Check that asynchronous RPC correlation, timeout cleanup, IPC disconnects, and bounded queues cannot leak results across requests or duplicate uncertain writes. A response code alone does not prove a complete downloaded file or accepted downstream message. Verification must check the actual result appropriate to the changed operation.

QQ feature evidence belongs to the exact runtime identity and tested scenario. An experimental build must not inherit native permissions or full capability claims from a version string or another build. Tests should exercise meaningful behavior or failure recovery; mocks do not establish QQ server support.

When reviewing, do not run tests that contact QQ or mutate accounts. Identify the relevant existing local tests and missing evidence for a maintainer to evaluate.
