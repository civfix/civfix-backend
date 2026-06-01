/**
 * REAL PushSender adapter: APNs (node-apn) for iOS, FCM (firebase-admin) for Android, and Web Push
 * (web-push) for browsers. Token storage is in Postgres.
 *
 * SCAFFOLD: bodies throw until a later step implements per-platform delivery.
 *
 * Seam rule: node-apn / firebase-admin / web-push may ONLY be imported in this file.
 */

import { AppError } from "@civfix/shared"
import type { PushSender, PushPayload, PushPlatform } from "@civfix/shared/interfaces"
import type { Db } from "../db/client.js"

export interface PushSenderConfig {
  apns?: {
    keyId: string
    teamId: string
    privateKey: string
    bundleId: string
    production: boolean
  }
  fcm?: {
    serviceAccountJson: string
    projectId?: string
  }
  webPush?: {
    publicKey: string
    privateKey: string
    subject: string
  }
}

export interface PushSenderDeps {
  db: Db
  config: PushSenderConfig
}

const NOT_IMPL = "adapter not implemented: push-sender"

export class MultiPushSender implements PushSender {
  private readonly deps: PushSenderDeps

  constructor(deps: PushSenderDeps) {
    this.deps = deps
  }

  registerToken(
    _userId: string,
    _token: string,
    _platform: PushPlatform,
    _deviceId?: string,
  ): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  send(_userId: string, _payload: PushPayload): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  sendMany(_userIds: string[], _payload: PushPayload): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
