# Configuration

Start from the two committed JSON files. Configuration is validated before any network work; unknown keys, invalid ranges, malformed selectors, and unsupported strategy types fail at startup.

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `PIPELINE_CONFIG` | Main JSON path, relative to working directory | `./config/main.json` |
| `DESTINATION_API_URL` | Override destination URL | Value in main JSON |
| `DESTINATION_API_KEY` | Destination bearer token | Empty |
| `MAX_ATTEMPTS` | Total attempts, including the first; 1–10 | JSON retry policy |
| `REQUEST_TIMEOUT_MS` | Source request deadline, including body | JSON network setting |
| `FFMPEG_PATH` | Executable name or absolute path | `ffmpeg` |
| `FFPROBE_PATH` | Executable name or absolute path | `ffprobe` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent` | `info` |

The CLI `--config` argument takes precedence over `PIPELINE_CONFIG`. Environment overrides never rewrite JSON files. `.env` uses Node's built-in parser.

## Main JSON

| Field | Meaning |
| --- | --- |
| `target` | Path to target JSON, relative to this file |
| `storage.temp` | Temporary job directories |
| `storage.output` | Optional completed file copies and metadata |
| `storage.reports` | Per-run reports |
| `storage.keepCompleted` | Retain completed media; default `true` |
| `retry.attempts` | Total attempts, default `3` |
| `retry.baseDelayMs` | Initial backoff, default `500` |
| `retry.maxDelayMs` | Maximum wait, default `10000`, maximum `300000` |
| `retry.jitter` | Randomize exponential delay, default `true` |
| `network.timeoutMs` | Per-attempt source HTTP timeout, default `30000` |
| `network.maxPageBytes` | Maximum HTML or playlist response, default `2097152` |
| `media.maxDownloadBytes` | Direct/HLS input cap, default `268435456` |
| `media.maxSegments` | Maximum segments in one HLS media playlist, default `1000` |
| `media.processTimeoutMs` | FFmpeg/FFprobe deadline per invocation, default `300000` |
| `destination.url` | Exact multipart POST endpoint |
| `destination.timeoutMs` | Per-attempt upload deadline including receipt, default `120000` |

`storage` and `destination` are required. The effective download cap is the lower of `media.maxDownloadBytes` and `validation.maximumBytes`. A time budget applies to each request/process, not to the entire crawl. Each discovered job tries at most 20 candidate media URLs.

## Target JSON

`baseUrl` resolves starting pages. `allowedOrigins` is a list of exact scheme/host/port origins; add media CDN and iframe origins explicitly. Do not include trailing slashes or paths. Every fetched URL, including redirect and HLS segment URLs, is checked. Only HTTP and HTTPS are supported; credentials embedded in URLs are rejected.

`discovery` fields:

| Field | Meaning |
| --- | --- |
| `startUrls` | One or more listing URLs, absolute or relative to `baseUrl` |
| `pageLinkSelector` | CSS selector for anchors whose `href` is a media page |
| `nextPageSelector` | Optional CSS selector for pagination anchors |
| `maxPages` | Maximum visited listing URLs; default `10` |
| `maxJobs` | Maximum emitted jobs, including duplicates; default `100` |

Listing URLs are visited at most once. A listing failure is recorded and other queued/start pages continue. Invalid and out-of-origin links are ignored. The crawler does not execute JavaScript or traverse arbitrary page links.

## Metadata rules

Each rule has a `selector` and optionally an `attribute`. Without an attribute, text content is used. Whitespace is normalized and HTML entities are decoded. The first match supplies a scalar; `multiple: true` collects unique strings. Use scalar rules for title, description, and thumbnail; tags are always an array.

```json
{
  "title": { "selector": "meta[property='og:title']", "attribute": "content" },
  "description": { "selector": ".description" },
  "thumbnailUrl": { "selector": "meta[property='og:image']", "attribute": "content" },
  "tags": { "selector": "a.tag", "multiple": true }
}
```

`title` is required in the config; the other fields are optional. Thumbnail URLs are normalized but thumbnails are not downloaded. `sourceUrl` is added by the pipeline.

## Media strategy rules

Strategies are evaluated in array order. Multiple candidates may be yielded by one selector; invalid or off-origin URLs are discarded. The pipeline can try the next candidate after download or validation failure. Media type is inferred from a `.m3u8` pathname, or set explicitly with `mediaType: "hls"` / `"direct"`.

CSS attribute:

```json
{ "type": "selector", "selector": "video source", "attribute": "src" }
```

A dotted property path in a JSON script block (numeric array keys work):

```json
{ "type": "json", "selector": "script#player", "path": "sources.0.url", "mediaType": "hls" }
```

First capture group of an HTML regex:

```json
{ "type": "pattern", "pattern": "data-media=\"([^\"]+)\"", "flags": "i" }
```

Iframe followed by nested strategies:

```json
{
  "type": "iframe",
  "selector": "iframe.player",
  "strategies": [{ "type": "selector", "selector": "video", "attribute": "src" }]
}
```

Iframe traversal tracks visited URLs, allows at most three nested levels, and inspects at most ten frames per iframe strategy. Regexes are trusted configuration: avoid pathological expressions. JSON values are parsed, never evaluated as JavaScript.

## Source headers

Keep header secrets in the environment and explicitly name which origins receive them:

```json
{
  "headerOrigins": ["https://media.example.com"],
  "headersFromEnv": { "Authorization": "SOURCE_AUTHORIZATION", "Referer": "SOURCE_REFERER" }
}
```

```env
SOURCE_AUTHORIZATION=Bearer replace-me
SOURCE_REFERER=https://media.example.com/
```

These fields belong at the top level of the target JSON. `headerOrigins` must be a subset of `allowedOrigins`. Headers are recalculated after every redirect and are not automatically forwarded to every CDN. Destination credentials use a separate client. There is no browser cookie jar or login automation.

## Validation

| Field | Meaning / default |
| --- | --- |
| `requiredMetadata` | Any of `title`, `description`, `thumbnailUrl`, `tags`; default `["title"]` |
| `minimumBytes` | Default `1` |
| `maximumBytes` | Default `268435456` |
| `minimumDurationSeconds` | Default `0`; actual duration must still be finite and positive |
| `maximumDurationSeconds` | Optional upper bound |
| `minimumWidth` / `minimumHeight` | Default `0` |
| `decode` | Full FFmpeg decode after probe validation; default `false` |

The example enables full decoding. Increase `media.processTimeoutMs` for long videos. Metadata failures skip the job before downloading. Rejected media can fall back to another candidate. If at least one candidate was rejected and none succeeded, the job is skipped with validation reasons; if every candidate failed operationally, the job fails. A validation skip is not automatically retried.

## Troubleshooting

| Result | Check |
| --- | --- |
| `CONFIG_READ_FAILED` | Working directory, JSON syntax, main/target paths |
| `INVALID_CONFIG` | The reported field, selector, or range |
| `PROCESS_UNAVAILABLE` | FFmpeg/FFprobe installed; executable path is correct |
| `MEDIA_NOT_FOUND` | HTML available without JavaScript; correct selectors and allowed origins |
| `UNSUPPORTED_HLS` | Finite, unencrypted playlist; no external audio or byte ranges |
| `MEDIA_TOO_LARGE` | Byte limit matches your intended workload |
| `PROCESS_TIMEOUT` | Process deadline is long enough for media duration/size |
| `HTTP_401` / `HTTP_403` | Correct credentials and source header origin rules |
| `INVALID_RECEIPT` | API returns a success status and JSON containing `id` |
| `invalid_media` | The file is decodable and contains a video stream |

A rejected destination receipt can follow a successful remote upload. Check the destination by idempotency key before manual recovery; do not assume the absence of a local completion record proves no remote side effect occurred.
