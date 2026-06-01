/**
 * REAL Storage adapter backed by Cloudflare R2 (S3-compatible) via the AWS SDK.
 *
 * SCAFFOLD: the seam boundary and types are wired, but the bodies throw until a later step fills
 * them in. Vendor SDK references are `import type` only so this file typechecks without the SDK
 * runtime present; the real implementation will switch to value imports inside the methods.
 *
 * Seam rule: @aws-sdk/* may ONLY be imported in this file (and never by application/domain code).
 */

import { AppError } from "@civfix/shared"
import type {
  Storage,
  PresignPutOptions,
  PresignPutResult,
  StorageHead,
  StoragePutMeta,
} from "@civfix/shared/interfaces"
// import type { S3Client } from "@aws-sdk/client-s3"

export interface R2StorageConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  publicBase?: string
}

const NOT_IMPL = "adapter not implemented: storage.r2"

export class R2Storage implements Storage {
  private readonly config: R2StorageConfig

  constructor(config: R2StorageConfig) {
    this.config = config
  }

  presignPut(_key: string, _opts: PresignPutOptions): Promise<PresignPutResult> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  presignGet(_key: string, _ttlSec: number): Promise<string> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  head(_key: string): Promise<StorageHead | null> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  delete(_key: string): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  put(_key: string, _body: Uint8Array | Buffer, _meta?: StoragePutMeta): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
