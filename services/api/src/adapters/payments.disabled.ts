import { AppError } from "@civfix/shared"
import type {
  AccountLink,
  ApplicationFeeRecord,
  ApplicationFeeRefund,
  BalanceTransactionRecord,
  CheckoutSessionSnapshot,
  ConnectedAccountStatus,
  DonationCheckoutSession,
  PaymentMethodDomainRegistration,
  PaymentRefundRecord,
  PaymentSnapshot,
  Payments,
  PaymentsMode,
  PaymentsPage,
  PaymentsWebhookEvent,
} from "@civfix/shared/interfaces"

export const PAYMENTS_DISABLED_MESSAGE = "Donations are not available."

function refuse(): never {
  throw AppError.paymentUnavailable(PAYMENTS_DISABLED_MESSAGE)
}

export class DisabledPayments implements Payments {
  mode(): PaymentsMode {
    return "test"
  }

  createConnectedAccount(): Promise<ConnectedAccountStatus> {
    return refuse()
  }

  createAccountLink(): Promise<AccountLink> {
    return refuse()
  }

  retrieveAccount(): Promise<ConnectedAccountStatus> {
    return refuse()
  }

  registerPaymentMethodDomain(): Promise<PaymentMethodDomainRegistration> {
    return refuse()
  }

  createDonationCheckout(): Promise<DonationCheckoutSession> {
    return refuse()
  }

  retrieveCheckoutSession(): Promise<CheckoutSessionSnapshot> {
    return refuse()
  }

  retrieveDonation(): Promise<PaymentSnapshot> {
    return refuse()
  }

  listRefunds(): Promise<PaymentRefundRecord[]> {
    return refuse()
  }

  listBalanceTransactions(): Promise<PaymentsPage<BalanceTransactionRecord>> {
    return refuse()
  }

  listApplicationFees(): Promise<PaymentsPage<ApplicationFeeRecord>> {
    return refuse()
  }

  refundApplicationFee(): Promise<ApplicationFeeRefund> {
    return refuse()
  }

  verifyWebhookSignature(): PaymentsWebhookEvent {
    return refuse()
  }
}
