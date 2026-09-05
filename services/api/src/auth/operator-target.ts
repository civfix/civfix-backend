import { AppError } from "@civfix/shared"

export const OPERATOR_ROLE = "operator"

export function isOperatorRole(role: string | null | undefined): boolean {
  return role === OPERATOR_ROLE
}

export function assertTargetIsNotOperatorRole(role: string | null | undefined, verb: string): void {
  if (isOperatorRole(role)) {
    throw AppError.forbidden(`You cannot ${verb} an operator account from the console.`)
  }
}
