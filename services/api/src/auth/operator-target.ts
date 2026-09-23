import { AppError } from "@civfix/shared"
import { isOfficialAccount } from "./official-account.js"

export const OPERATOR_ROLE = "operator"

export function isOperatorRole(role: string | null | undefined): boolean {
  return role === OPERATOR_ROLE
}

export function assertTargetIsNotOperatorRole(role: string | null | undefined, verb: string): void {
  if (isOperatorRole(role)) {
    throw AppError.forbidden(`You cannot ${verb} an operator account from the console.`)
  }
}

export function assertTargetIsNotOfficialAccount(userId: string, verb: string): void {
  if (isOfficialAccount(userId)) {
    throw AppError.forbidden(`You cannot ${verb} the official CivFix account from the console.`)
  }
}
