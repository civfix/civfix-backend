const THUMBNAIL_PREFIX = "thumbs/"
const THUMBNAIL_SUFFIX = ".jpg"
const SERVED_PREFIX = "processed/"

export function thumbnailKey(r2Key: string): string {
  return `${THUMBNAIL_PREFIX}${r2Key}${THUMBNAIL_SUFFIX}`
}

export function servedKey(r2Key: string): string {
  return `${SERVED_PREFIX}${r2Key}`
}
