# Architecture and component contracts

`main.js` loads configuration and handles the process lifecycle. `create-pipeline.mjs` constructs the adapters. `Pipeline` owns ordering and per-job outcomes; it does not parse HTML, build multipart forms, or implement HTTP retries.

## Contracts

| Component | Input | Output / responsibility |
| --- | --- | --- |
| Source `discover({signal, onError})` | Cancellation and listing-error callback | Async iterable of normalized media-page URLs |
| `extractMetadata(html, pageUrl, rules)` | HTML and configured CSS rules | Normalized metadata with sourceUrl and tags |
| `mediaCandidates(...)` | HTML, ordered strategies, HTTP client and bounds | Async iterable of `{type, url}` candidates |
| Downloader `(url, path, options)` | Destination temp path, client, limits, signal | `{path, bytes, contentType, expectedDurationSeconds?}` |
| `validateMedia(file, rules, options)` | Downloaded file and actual media constraints | `{valid, reasons, facts}` |
| Destination `publish({metadata, file, sha256, facts}, {signal})` | A validated file and normalized metadata | Confirmed receipt containing an ID |
| `Pipeline.run({signal})` | Cancellation | Run report, job results, summary, reportPath |

Inject a source or destination through `createPipeline(config, {source, destination})`. For other download formats, construct a `Pipeline` with a downloader map. Built-in validation remains a concrete module in V1; it is not an unnecessary plugin framework.

## Job lifecycle

A job is one discovered page. It starts with an ID and source URL. Its `stage` progresses through extraction, download, validation, publish, and done. `status` ends as:

| Status | Meaning |
| --- | --- |
| `completed` | Destination confirmed a valid receipt |
| `skipped` | Duplicate page/content or a validation rejection |
| `failed` | Extraction, transfer, process, or publication could not complete |
| `cancelled` | Operator cancellation interrupted this job |

A rejected candidate can still lead to a completed job if a later candidate works. One failure does not stop later discovered jobs. Failed listing pages are separate `sourceErrors`; jobs that could never be discovered cannot have fabricated job records. Discovery is lazy, so cancellation does not claim to account for unseen pages.

## Retry ownership

The HTTP client owns network retries. The operation includes consuming the response body; a successful header alone is not a successful download. The downloader removes its `.part` file before the next attempt. An upload body is recreated from the file for each attempt.

Permanent errors and validation rejections are not retried. Media extraction provides fallback candidates independently of retry. FFmpeg is invoked only on already-downloaded local data, with a deadline and bounded diagnostic output. HLS fetches every declared segment before remuxing, eliminating FFmpeg's network behavior from the retry contract. Unsupported HLS features fail explicitly.

## Files and publication order

1. Create an isolated temporary job directory.
2. Download a candidate to a `.part` file, then rename only after the stream finishes.
3. Probe/optionally decode and hash the completed file.
4. Publish it and validate the receipt.
5. Mark completed and optionally copy media plus metadata to a run-specific output directory.
6. Remove the temporary job directory.
7. Atomically write the run report after the job finishes.

A retention failure after confirmed publication is recorded separately and does not pretend the remote upload failed. Cleanup failures are also recorded. Reports are written before the first remote action to catch an unwritable reports directory early; later disk errors still remain possible.

Reports are observational records, not a transactional job database. A hard crash between remote acceptance and the next report write leaves an ambiguous outcome. Destination idempotency reduces that ambiguity on retry; V1 does not implement restart checkpoints. Writes use temp-file rename, but are not a claim of power-loss durability or an fsync-backed transaction.

## Bounds and cancellation

The source bounds listing pages and emitted jobs. HTML, playlist, media, API-response, segment-count, candidate-count, frame-depth, and child-output limits constrain work. Every network attempt has a deadline that covers its body. External process execution uses argument arrays, never a shell.

SIGINT/SIGTERM abort HTTP, streams, retry waits, and media subprocesses. Subprocesses are terminated, escalated to a hard kill after a grace period if necessary, and awaited before cleanup. The pipeline writes a final cancelled report. SIGKILL, power loss, and runtime termination cannot be handled this way.

Exit codes: `0` for completed runs (including normal validation skips), `1` for run/startup failure, `130` for SIGINT, `143` for SIGTERM. `npm run demo` has its own expectation checks because its fixtures intentionally include failure.

## Why these boundaries

The public implementation uses a small, configurable source and reference destination instead of carrying forward production-site-specific behavior. It retains practical ideas from earlier automation work: sequential resource use, retry/backoff, validation, staged processing, and isolated failures. Production URLs, credentials, private content policies, browser login flows, and old logs are not part of this repository.

There is no database, worker pool, dashboard, or scheduling daemon in V1. The next useful extension would be a durable job store with explicit stage checkpoints and recovery rules. Add that when there is a concrete persistence requirement, rather than implying the current JSON reports already provide it.
