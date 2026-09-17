# resilient-media-pipeline

A Node.js pipeline that discovers video pages, finds media, downloads it, checks it, and publishes it to an HTTP API. Website rules live in JSON; secrets and deployment settings live in `.env`.

The interesting part is what happens when something goes wrong. Downloads can break halfway through. A destination can accept an upload and lose the response. A page can contain a broken video URL before a working one. This project handles those cases explicitly and records the result of each job.

## Run the demo

Requirements: **Node.js 22.17+** (24 recommended), **FFmpeg and FFprobe** on PATH. The demo needs an FFmpeg build with `libx264` and `aac` encoders. On Ubuntu, install the media tools with `sudo apt-get install ffmpeg`.

```bash
git clone https://github.com/ella4moon/resilient-media-pipeline.git
cd resilient-media-pipeline
npm ci
npm run demo
```

The demo generates four tiny synthetic clips, starts a source website and destination API on a free loopback port, runs the real pipeline, checks the results, and stops the server. It does not need an account, an API key, third-party media, or an `.env` file. It ignores real destination credentials.

Expected result:

```text
Demo passed: 4 uploads, 3 intentional skips, 1 isolated missing-media failure.
Recovered from source/API 503s and an accepted upload with a lost acknowledgement.
```

The demo intentionally includes a missing video, so its JSON run report has `status: "failed"`. The **demo command exits successfully** only when all expected outcomes match. A normal pipeline run exits nonzero when any job or listing fails.

Open the printed report path to inspect every job. Uploaded clips and metadata are in the printed `received` directory under `storage/demo/`. The `.bin` extension on retained pipeline files is deliberate: the direct downloader does not pretend every source is MP4. FFprobe detects their real format; the synthetic demo destination writes its known MP4 inputs as `.mp4`.

## What V1 does

- Discovers pages using CSS selectors, follows configured pagination, and bounds the crawl.
- Extracts title, description, thumbnail URL, and tags.
- Tries media strategies in order: CSS attribute, JSON script value, regular-expression capture, and bounded iframe traversal. A broken candidate can fall back to the next one.
- Streams direct downloads to temporary files. Retries start a fresh attempt; incomplete files never become completed output.
- Downloads finite HLS playlists and their segments with the same network retry policy, then remuxes locally with FFmpeg. Supports media/master playlists and a single fMP4 initialization segment. The highest-bandwidth variant is selected.
- Validates required metadata, bytes, duration, dimensions, and the presence of a video stream with FFprobe. Optional full decoding catches additional corrupt-media errors. HLS output duration is checked against the playlist.
- Uploads a file and normalized metadata as multipart form data, with a stable idempotency key.
- Skips duplicate page URLs and already-published content hashes **within a run**.
- Retries transient errors with exponential backoff and jitter; honors bounded `Retry-After` instructions.
- Continues after individual failures, logs structured events, saves a JSON report, and cancels active work on SIGINT/SIGTERM.

V1 runs sequentially, once. It does **not** provide a durable job queue, automatic resume, cross-run local deduplication, browser automation, authenticated browser sessions, DASH, live HLS, encrypted/DRM media, HLS byte ranges, or separate HLS audio renditions. These are explicit boundaries, not unfinished stubs. Ordinary source HTTP headers can be supplied through environment variables.

## Use your own target

1. Copy `.env.example` to `.env`.
2. Copy `config/targets/demo.json` to `config/targets/local.json` and replace the source URL, allowed origins, selectors, and validation rules.
3. Copy `config/main.json` to `config/local.json`; set `target` to `./targets/local.json`.
4. Set `PIPELINE_CONFIG=./config/local.json` and `DESTINATION_API_URL` in `.env`. Set `DESTINATION_API_KEY` if your endpoint uses bearer authentication.
5. Make sure your destination implements the [HTTP contract](docs/destination-api.md), then run:

```bash
npm start
# Or select a config explicitly:
npm start -- --config ./config/local.json
```

The committed demo config is a template. Its fixed example ports do not start servers when you run `npm start`; use `npm run demo` for the self-contained demonstration.

Relative target/storage paths are resolved from the **main config file's directory**. `.env` is loaded from the current working directory. Existing process environment values take precedence over `.env`. Private `local*.json` configurations, `.env`, logs, and storage are ignored by Git.

See [configuration](docs/configuration.md) for every option and examples. Only configure source sites and media you are authorized to access and process.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/main.js` | Load configuration, handle signals, choose the exit code |
| `src/create-pipeline.mjs` | Wire the concrete adapters together |
| `src/core/pipeline.mjs` | Coordinate jobs and write reports |
| `src/core/job.mjs` | Create one job and record its final status |
| `src/sources/web-source.mjs` | Discover media-page URLs |
| `src/extractors/` | Extract metadata and ordered media candidates |
| `src/downloaders/` | Transfer direct files or assemble HLS |
| `src/validators/media.mjs` | Check metadata and actual media facts |
| `src/destinations/http-api.mjs` | Publish multipart uploads and validate receipts |
| `src/utilities/` | HTTP, retry, process, file, URL, and logging helpers |
| `examples/demo-site/` | Local source/API and synthetic-media generator |
| `tests/unit/` | Small component tests |
| `tests/integration/` | Real HTTP, files, FFmpeg, and CLI behavior |
| `tests/fixtures/` | Known input files used by tests |

[Architecture and contracts](docs/architecture.md) explain the design and its tradeoffs.

## Verify it

```bash
npm run check
npm test
npm run demo
```

Tests cover interrupted downloads, request-body timeouts, upload acknowledgement loss, permanent errors, byte limits, missing HLS segments, pagination cycles, ordered fallback, duplicate content, invalid media, child-process cancellation, and CLI SIGTERM behavior. They run locally; no external site is part of the test suite. GitHub Actions runs the same checks on Node.js 22 and 24.

## Operational details

Default downloads are capped at 256 MiB, listing/iframe pages at 2 MiB, response receipts at 64 KiB, and source requests at 30 seconds **per attempt including the body**. Configure limits for your workload. HLS's byte cap applies both to aggregate fetched media and the assembled file; remuxing can temporarily require additional disk space.

Each run writes `storage/reports/<run-id>.json`. Completed media can be retained in `storage/output/<run-id>/<job-id>/`; set `storage.keepCompleted` to `false` to keep only reports. Temporary job directories are removed after success, rejection, failure, or handled cancellation. A hard kill or power loss can leave temporary files; inspect and remove abandoned directories when no process is using them. V1 never claims to resume those files.

Reports contain source URLs and extracted metadata, which may themselves be private or include signed query strings. Treat storage as private. Logs deliberately omit request headers, raw URLs, response bodies, and arbitrary exception messages. Executable paths, configuration, and regular expressions are trusted operator input. Origin allowlists limit crawling and redirects; they are not a sandbox for untrusted configuration or a defense against DNS rebinding. Avoid running as root.

A successful destination response must contain a JSON `id`. Retry safety depends on the destination enforcing `Idempotency-Key`. This is not a claim of exactly-once delivery. [The destination contract](docs/destination-api.md) describes the acknowledgement-loss case.

## License

No software license is granted for this repository. It is published for inspection as a portfolio project. `package.json` is marked `UNLICENSED` and private to prevent accidental npm publication. Dependencies retain their own licenses.
