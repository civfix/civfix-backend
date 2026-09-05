
export function thumbnailKey(r2Key: string): string {
  return `thumbs/${r2Key}.jpg`
}

export function servedKey(r2Key: string): string {
  return `processed/${r2Key}`
}
