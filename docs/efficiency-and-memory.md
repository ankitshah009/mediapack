# Efficiency, video memory, and transport

MediaPack pays the indexing cost once for an uploaded source, persists the resulting timeline, and answers subsequent questions from that stored index. Callers retrieve source frames or a short playable clip when they need pixels. The benefit is reuse of inspected evidence within a bounded pack, with usage accounting and source references an agent can act on.

## What counts as video memory

The durable memory is in Supabase:

| Persisted material | Purpose |
| --- | --- |
| Immutable source reference and SHA-256 | Identify the exact recording that was inspected |
| Timestamped frame observations, visible text and speech records | Search the existing timeline without sending every sampled image again |
| Versioned index artifact and database records | Reuse the inspection across questions and disposable worker processes |
| Exported frames/clips, actual source times and hashes | Reuse and verify the evidence already delivered |
| Jobs, operations, usage, outbox, inbox and events | Preserve ownership, progress, retries and allowance accounting |

Worker RAM is temporary. A 4 GB worker can finish or disappear while its committed index, artifact references and operation history remain available to the control service. An agent does not need to keep the full recording in its conversation context to ask another question.

This is source-specific retrieval memory, not continual model training or unrestricted cross-video recall. It is not a promise of permanent archival storage. The current pack permits **three distinct searches**, **eight delivered frames**, **15 seconds of clips**, and **8,000 characters of evidence text**, with a **24-hour access window**. Ownership checks, pack expiry and configured storage cleanup still apply. A cached retry does not create a new allowance; short-lived signed artifact URLs are access grants, not permanent public links.

## Why Primitive matters

Primitive carries the signed work-request and work-result messages between control and disposable workers. The searchable timeline and evidence remain in Supabase; Primitive provides the transport that lets separate processes collaborate without sharing one long-lived request or in-memory session.

The control service commits an operation, allowance reservation and outgoing payload/idempotency key before sending. Verified Primitive delivery supplies the stable message identity used by the inbox and the operation claim. The worker reads media through scoped access, writes artifacts to private Storage, then replies with the result and artifact references. Control validates the signature, deduplicates the provider event, checks the operation/generation and source identity, and commits the result through SQL helpers.

This separation matters when a webhook is repeated, a process crashes, an old worker replies late, or the web host enters standby. Stable message identities and idempotency keys work with SQL deduplication, leases, generation checks and recovery; transport alone does not enforce payment or allowance. The installed idle-aware recovery schedule dispatches only due work. Media bytes stay in Storage rather than being placed in the messaging payload.

## Historical measurement: October 18, 2026

A historical `gpt-4o-mini` talk-recording run on October 18, 2026 produced these counts. This was the original search before the temporal-grounding instruction update:

| Observation | Value |
| --- | ---: |
| Frames inspected during the initial vision pass | 23 |
| Persisted temporal records available to search | 32 |
| Reported model input tokens for the initial vision pass | 326,710 |
| Reported model input tokens for the first search over the index | 2,507 |

These are input-token measurements from that historical run. The final search has longer temporal-grounding instructions, so 2,507 is not a fixed current-search cost or a promise about the patched deployment. See the [dated verification record](verification.md) for deployed acceptance results, which do not change this historical token baseline.

The measured search used **324,203 fewer input tokens** than repeating that same full 23-frame indexing pass. Its **incremental search input** was **99.23% lower**, or about **130× smaller**:

```text
326,710 - 2,507     = 324,203 fewer input tokens for that search
1 - (2,507 / 326,710) = 99.23% lower incremental input
326,710 / 2,507      = 130.32× input-count ratio
```

The first question still pays the indexing cost. Under this accounting, indexing plus the first search uses **329,217 input tokens**. The 99.23% figure therefore describes the size of a subsequent index search relative to the recorded full-frame pass; it is not an end-to-end first-question saving.

For the current pack's three-question limit, assume each search uses the same 2,507 input tokens as the first measured search:

```text
Index once, then three searches: 326,710 + 3 × 2,507 = 334,231
Repeat the same full pass:                  3 × 326,710 = 980,130
Projected avoided input:            980,130 - 334,231 = 645,899 tokens
Projected input reduction:       1 - 334,231 / 980,130 = 65.90%
```

The **645,899 avoided input tokens** are a **counterfactual calculation**, not three measured searches or a measured competing product. Its baseline deliberately repeats the same recorded full-frame indexing pass for each question. A real direct-video question-answering system could use different sampling, prompts, image detail, models, caching or its own persisted index. The calculation does not establish its token usage.

The comparison excludes model output tokens, provider caching and cache discounts, later retrieved images/video consumed by the buyer agent, local ASR/ffmpeg work, storage, transport and compute charges. It is neither a dollar-savings measurement nor a latency or GPU-efficiency result. Different videos and questions can produce different input counts. Sampling can also miss brief events: lower input is useful only when the returned evidence supports the answer.

## How this differs from NVIDIA VSS

NVIDIA VSS already has persisted retrieval memory. Its documented architecture separates ingestion from retrieval, stores captions/transcripts and metadata in vector and graph databases, and retrieves relevant indexed information for Q&A with reranking. [NVIDIA VSS 2.3 architecture](https://docs.nvidia.com/vss/2.3.0/content/architecture.html).

MediaPack's emphasis here is a small, paid, agent-facing retrieval contract: one immutable source, a bounded allowance, client ownership, retry-safe operations, and reusable source frames/clips with actual times and hashes. The current short-video implementation uses a bounded stored text index rather than a vector/graph retrieval stack. The measured ratio above compares two uses of MediaPack's recorded input count; it is **not an NVIDIA benchmark** or a claim of GPU superiority.

## Inkbox and the initial transport trial

In the project team's initial hands-on evaluation, Primitive was **slightly more responsive than Inkbox**. This is a qualitative project observation, not a controlled benchmark. There are no comparable latency distributions, sample counts or percentages recorded here, and the current repository has no Inkbox adapter. No feature or performance parity is implied.

Inkbox remains an alternative to evaluate if the transport is revisited. First verify its actual API and whether it can satisfy this application's delivery, authentication, message-identity and retry contract. A useful controlled comparison would hold payloads, source/workload, worker resources, region and warm/idle state constant, and measure commit-to-dispatch, delivery-to-worker-start and result-to-database-commit separately. That would distinguish transport responsiveness from ASR, inference and cold-start time without inventing a capability or a speed claim.
