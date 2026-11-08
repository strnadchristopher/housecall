# Whole-object scanner source review

Independent Astra/high reviewer `/root/native_review` inspected the candidate scanner adapter, server configuration and Compose scratch policy. No source-confirmed clean-release bypass found. Combined stdout/stderr budget, stdin EOF/unread data, timeout/error and overload quarantine cases are authored in `crates/media/tests/whole_object.rs`; they are not real-engine coverage evidence.

Review corrections: scanner tmpfs can swap, so Compose now sets `memswap_limit` equal to `mem_limit`; validate effective runtime enforcement. Process cleanup previously reaped the leader before killing its numeric private process group. Linux `waitid(... WNOWAIT)` now observes exit without reaping; Drop kills the owned group before Child.wait. Reviewer reread and confirmed this removes the identified reuse window.

This is source review only. No Rust tests, container validation or licensed scanner execution was run by the reviewer. Real engine provisioning, complete >2GiB clean/malicious analysis, playback and temp-data/cloud-policy checks remain acceptance gates. ClamAV default and whole-original release gates remain unchanged.
