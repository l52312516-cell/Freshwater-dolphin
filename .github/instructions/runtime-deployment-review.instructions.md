---
applyTo: "deploy/**,tools/windows/**,tools/qq-runtime-entry.cjs,tools/prepare-qq.cjs,src/manager/**,Freshwater.cmd,.github/**"
excludeAgent: "cloud-agent"
---

Review deployment, account lifecycle, runtime selection, restore, and automation changes for isolation, ownership, and interrupted-operation recovery. Prioritize paths that could overwrite private state, start an unverified runtime, leak a credential, or report an unconfirmed stop as successful.

All temporary files, caches, packages, and reports belong in the actual project workspace: `work/` for intermediates and `outputs/` for deliverables. Path validation must cover the root and ancestors, symbolic links, junctions, reparse points, and other escape paths before mutation. Avoid shell interpolation of untrusted values and mutable executable configuration.

For Windows, the current implementation is a launcher using a dedicated Alpine WSL2/Docker guest running Linux QQ; it is not native Windows QQ 9.9.x support. Do not equate host platform with the actual QQ guest platform. Keep VHDX, swap, login state, and tokens private. Verify the owned distro, container, daemon, image identity, authenticated service handshake, and deferred activation boundaries.

Before replacing a QQ runtime or container image, stop writes and confirm shutdown. Snapshot complete private work plus runtime configuration. Consider guest free space and host physical free space. Persist transaction intent before destructive renames and recover crashes after each rename; never feed newly migrated state to the old runtime. A failed activation after writes are possible must not trigger an automatic rollback to old data.

Workflow permissions must be minimal. Do not run a PR's code with a privileged base-branch token, expose secrets to forks, auto-approve/merge, or replace existing CI with AI output. Repository review instructions are guidance, not an executable security boundary. Do not change subscription, billing, or quota without explicit authorization.
