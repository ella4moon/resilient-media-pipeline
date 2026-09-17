# HTTP destination contract

The reference adapter sends one request per media item:

```http
POST /api/media
Authorization: Bearer <DESTINATION_API_KEY>
Idempotency-Key: <sha256(sourceUrl + NUL + contentSha256)>
Content-Type: multipart/form-data; boundary=<generated>
```

Authorization is omitted if no API key is set. The URL is configured; redirects are rejected so upload credentials are not sent to another endpoint.

Multipart fields:

| Field | Content |
| --- | --- |
| `file` | File-backed streaming blob; filename `media.bin`; source MIME type or `video/mp4` for assembled HLS |
| `metadata` | JSON string: sourceUrl, title, tags, optional description/thumbnailUrl, sha256, and media facts |

Example metadata:

```json
{
  "sourceUrl": "https://source.example/video/1",
  "title": "Sample clip",
  "tags": ["demo"],
  "sha256": "<64 hexadecimal characters>",
  "media": {
    "bytes": 12000,
    "hasVideo": true,
    "durationSeconds": 1.2,
    "width": 160,
    "height": 90,
    "videoCodec": "h264",
    "hasAudio": true
  }
}
```

The destination should inspect media rather than trust a filename/MIME declaration. The reference adapter does not download thumbnails or rewrite content for a destination's custom schema. Implement a different `publish()` adapter for such requirements.

## Success response

Return a 2xx status and at most 64 KiB of JSON containing a nonempty string or numeric `id`:

```json
{ "id": "media-123" }
```

Other response fields are ignored. A 204 empty response, malformed JSON, or missing ID is a contract error. The pipeline cannot safely treat it as a confirmed publish.

## Idempotency matters

A connection may break **after** an upload is accepted. The pipeline retries transient failures with the same key and reopens the file for each multipart body. The server must atomically associate that key with the publish result and return the original result for repeated requests. Concurrent duplicate requests should not create duplicate objects. Retain keys for at least your retry/manual-recovery window, ideally for the item's lifetime.

The local demo stores the first upload, deliberately drops its acknowledgement, and returns the same ID when the retry arrives. Its in-memory receipt map is for demonstration only; a production API should store idempotency records durably with its media records.

The key includes source page URL and file SHA-256. It is stable across runs for the same page and identical bytes. It is **not** a global content-only deduplication key; different source URLs can represent the same bytes. The pipeline additionally suppresses identical content within a single run after a confirmed publish.

There is no exactly-once guarantee across arbitrary external APIs or process crashes. If the API ignores idempotency keys, retrying uploads can create duplicates.

## Failure response

The adapter retries connection failures, timeouts, and HTTP 408, 425, 429, 500, 502, 503, and 504. Most other status codes are permanent. `Retry-After` may be seconds or an HTTP date. If the requested wait exceeds the configured maximum wait, the current operation fails rather than retrying sooner than requested.

API responses and authorization headers are not put in logs. A job that exhausts publish retries fails; later jobs still run. Temporary media is removed, so another run downloads again. Implement durable checkpoints if your use case requires upload-only resume.
