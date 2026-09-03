/**
 * Storage key scheme for processed media. ONE definition shared by the writer (media.checks, which PUTs
 * the processed object + thumbnail) and the reapers (orphan.sweep / reject cleanup, which delete them)
 * so the two can never drift on the path.
 */

/** Derive the thumbnail key from the source key. */
export function thumbnailKey(r2Key: string): string {
  return `thumbs/${r2Key}.jpg`
}

/**
 * Derive the SERVED key from the upload key (C1).
 *
 * The upload key is the one the client holds a presigned PUT for, and that PUT stays valid for its full
 * TTL — including after the worker has already vetted the bytes. Publishing the processed object under a
 * key the client was never given a PUT for is what makes "ready" mean "these exact bytes passed every
 * check": nothing outside the worker can write here. The upload object is deleted once this one exists.
 */
export function servedKey(r2Key: string): string {
  return `processed/${r2Key}`
}
