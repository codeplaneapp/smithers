---
title: "Serve the artifact protocol"
description: "The HTTP surface a shared artifact tier owes RemoteArtifacts: four requests, the status codes that mean hit, miss, and failure, the body bounds, and the optional resumable upload sequence."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/guides/serve-the-artifact-protocol.md"
---

`RemoteArtifacts` speaks a dumb-HTTP content-addressed cache protocol, the one
Bazel's `HttpCacheClient` documents, with two additions. If you are writing the
service on the other end, this page is the contract.

Every digest in a path or a body is 64 lowercase hexadecimal characters. The
client validates that before a request leaves, so a malformed address never
reaches your service.

## The four requests

All paths are resolved beneath the configured endpoint. A trailing slash on the
endpoint is ignored.

| Request                 | Conforming answer                                    | Anything else                          |
| ----------------------- | ---------------------------------------------------- | -------------------------------------- |
| `GET /cas/{digest}`     | `2xx` with the blob bytes, or `404` for a miss       | Fails the read as `transport_failed`   |
| `PUT /cas/{digest}`     | Any `2xx` once the blob is durable                   | Fails the upload as `transport_failed` |
| `HEAD /cas/{digest}`    | `2xx` when the blob is present, `404` when it is not | Fails the probe as `transport_failed`  |
| `POST /cas/findMissing` | `200` with `{"missing":[...]}`                       | Fails the batch as `transport_failed`  |

`404` is the only status that means "miss". Every other non-2xx is a failure of
the tier, which is the only classification a dumb-HTTP cache can support,
because there is no richer error envelope on the wire.

## What the client does with your answers

Knowing this saves you from defending against problems the client already
handles, and from assuming defenses it does not have.

- **Every download is digest verified.** A `GET` body that does not hash to the
  requested address is rejected with `ArtifactCorruption`, never returned. Your
  service cannot substitute content, and it does not need to prove it did not.
- **An absent body is zero bytes, not an error.** The digest check decides
  whether empty content is the requested artifact.
- **`Content-Length` is read strictly.** It must be plain decimal digits naming
  a safe integer. A malformed one fails the read before the body is buffered.
- **Downloads are bounded.** A declared length past `maxDownloadBytes`, 256 MiB
  by default, is refused before a body byte is read, and an incremental read
  stops one chunk past the bound.
- **`findMissing` answers are filtered.** The client keeps only digests it
  asked about, in request order. A digest you return that nobody asked for
  makes the client upload nothing.

## The findMissing body

Request, sent as `application/json`:

```json
{ "digests": ["077303668cf56af8d162bb5ccccd7127f2e8baff448bf5b649530a98e9c943da"] }
```

Response, also JSON:

```json
{ "missing": ["077303668cf56af8d162bb5ccccd7127f2e8baff448bf5b649530a98e9c943da"] }
```

The client enforces three bounds on its side, and a conforming service can rely
on them:

| Bound               | Value                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Digests per request | At most 1,000. A larger input is split into several batches.                                                  |
| Request body        | At most 256 KiB, which the 1,000-digest cap already guarantees.                                               |
| Response body       | At most `maxFindMissingResponseBytes`, 256 KiB by default, and that option may only lower the protocol bound. |

An empty input never leaves the process, so your service never sees a
zero-digest batch.

## The optional resumable upload

A client with `RemoteArtifacts.Options.chunkBytes` set sends a large blob as a
sequence of ranged `PUT` requests. Supporting this is optional, and refusing it
correctly costs the client one round trip.

The sequence is:

1. `HEAD /cas/{digest}`. Answer `2xx` with a `Content-Length` equal to the
   whole blob if you already hold it, and the client sends nothing more.
2. `PUT /cas/{digest}` with `Content-Range: bytes */{total}` and an empty body.
   Answer `308` with `Range: bytes=0-{last}` naming the prefix you hold, or
   omit the header if you hold none.
3. `PUT /cas/{digest}` with `Content-Range: bytes {a}-{b}/{total}` per chunk.
   Answer `308` to continue, and a `2xx` on the chunk that completes the blob.
4. `HEAD /cas/{digest}` again. The client confirms the stored length before it
   reports the digest as published.

Only `308` continues the sequence. A `2xx` to the empty probe, or to a chunk
that does not complete the blob, reads as a tier that ignored `Content-Range`
and stored the body it was handed, which is what plain WebDAV `PUT` does.

**To refuse ranged uploads,** answer `400`, `411`, or `416`. `400` is RFC 9110
section 14.5's answer from a resource that does not support partial `PUT`, and
it is what both of this repository's cache services send. The client then sends
one whole-blob `PUT`, which overwrites any partial body the sequence left
behind, so the blob always lands whole.

Falling back on `400` cannot mask a genuine `400` from your service: the
whole-blob `PUT` that follows presents the same URL, digest, and credential, so
a real refusal comes straight back on that request.

## The reference implementation

This repository ships a conforming service, deployed as a Cloudflare Worker
over R2 and D1, and a self-hosted build of the same protocol. Its behavior is a
useful default when you are deciding what your own should do:

| Request                 | What it does                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `GET /cas/{digest}`     | Streams the object as `application/octet-stream`; missing objects return `404`           |
| `PUT /cas/{digest}`     | Hashes the complete upload before an atomic publication; a digest mismatch returns `400` |
| `HEAD /cas/{digest}`    | Checks for the object without returning a body; missing objects return `404`             |
| `POST /cas/findMissing` | Accepts `{"digests":[...]}` and returns unique missing digests in request order          |

Its bounds: a `/cas` upload is capped at 16 MiB and must be
`application/octet-stream`; a `findMissing` request is capped at 256 KiB, 1,000
digests, and `application/json`. Reads accept either credential; `PUT` and
`DELETE` require the write credential and answer `403` to the read one, before
the request body is read.

Because it caps a request body at 16 MiB and refuses ranged `PUT` with `400`, a
blob larger than 16 MiB is refused with `413` whether or not `chunkBytes` is
set. See [`@smthrs/build`](https://smithers-build.smithers.sh/) for how that service is
deployed and configured.

## Related

- [Share artifacts across machines](/guides/share-artifacts-across-machines/): the
  client side of this protocol.
- [The three tiers](/concepts/tiers/): what the combined store does with a
  miss, a failure, and a corrupt address.
- [Troubleshooting](/troubleshooting/): the transport failures a
  nonconforming answer produces.
