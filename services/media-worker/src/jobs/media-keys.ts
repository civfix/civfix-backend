/**
 * Storage key scheme for processed media. ONE definition shared by the writer (media.checks, which PUTs
 * the thumbnail) and the reaper (orphan.sweep, which deletes it) so the two can never drift on the path.
 */

/** Derive the thumbnail key from the source key. */
export function thumbnailKey(r2Key: string): string {
  return `thumbs/${r2Key}.jpg`
}
