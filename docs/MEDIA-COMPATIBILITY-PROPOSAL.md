# Upload policy decision for Noah

**Proposed, not approved or implemented. Preserve current quarantine and release defaults until Noah reviews the policy and the required tests pass.** Christopher requires intense security **and no upload size cap except available disk**. WithSecure is an optional experiment, not a user requirement, purchase request, or mandatory release prerequisite. Preserve its adapter and evidence.

## Recommended no-new-spending approach

Retain encrypted originals as untrusted data, with separate upload, scan-coverage and playback states. Continue ClamAV scanning where supported. Recommend explicit authenticated downloads of coverage-limited originals and isolated processing of supported media, with separate validated, fully scanned playback outputs. Neither signature scanning nor transcoding guarantees safety from unknown exploits.

ClamAV documents an approximately 2 GiB single-object analysis limit. Increasing stream limits or scanning arbitrary chunks does not establish complete original coverage. Current code blocks unscanned originals from both download and transcoding; changing either boundary requires deliberate review. [Official ClamAV configuration](https://raw.githubusercontent.com/Cisco-Talos/clamav/main/etc/clamd.conf.sample).

| Proposed status | Original download | Playback/action |
| --- | --- | --- |
| Detected malware/blocking security verdict | Block, including owner; no bypass | Cancel jobs, withdraw derivatives; delete or controlled rescan |
| Supported whole-object scan completed, no finding | Authenticated attachment | Process supported media; independently validate/scan outputs |
| Coverage limited: size, encryption, unsupported format or archive limits | Explicit “Download original — scan incomplete,” **only after policy approval** | Isolated processing for supported media only; source remains unknown |
| Scanner unavailable/error/timeout/stale | Block pending retry | No new output release; recover and retry |
| Decode/integrity/resource failure | Follow independent scan verdict; integrity failures block | No partial success; explain failure and retryability |

An explicit unknown-file download transfers residual risk to the recipient; attachment headers cannot protect someone who opens it locally. Preserve authentication/membership on every range, attachment MIME/disposition, `nosniff` and `no-store`; never inline originals or automatically open downloads. Detected always overrides other states. Archives, encrypted files and nonmedia remain stored without previews; scanner errors cannot masquerade as coverage limitations. Opus owns interaction and visual design.

Processing requires a separate unprivileged worker, no network or secrets, restricted filesystem/syscalls, bounded CPU/memory/time/processes/scratch and complete cleanup. Encrypt disk scratch; account for scanner temporaries and swap because tmpfs can swap. Decode/re-encode approved streams into bounded, independently scannable complete output objects; validate and scan every object before publishing an authenticated playback index. No arbitrary chunk-scan substitution. Decoder/kernel escapes remain residual risks. Resource exhaustion pauses/fails processing recoverably; it must not become a hidden permanent upload-size cap.

## Staged implementation and activation

Truthful scan-coverage schema/status reporting and disabled capabilities can be implemented while review is pending, **without changing current quarantine, download or processing gates**. Legacy ambiguous quarantines stay blocked; old clients must never receive unknown as `ready`.

**Decision requested:** approve or revise the explicit unknown-original download and isolated unknown-source processing boundaries. Approval permits staged implementation; default activation additionally requires verified containment and acceptance evidence.

Before activation, prove actual >2 GiB video upload interruption/resume, authenticated ranges, early/middle/late playback and outside-buffer seek on supported clients. Verify detected blocking versus coverage/error states, complete output scans, isolation/swap controls, disk-full and worker/scanner recovery, and deletion/revocation across every output. Existing large-upload evidence ends in quarantine; existing small-video evidence leaves native/outside-buffer seeking unverified.

[Detailed containment, compatibility, primary sources and measurable acceptance cases](MEDIA-COMPATIBILITY-DESIGN.md) support this decision; they are research and proposed tests, not completed implementation or approval.
