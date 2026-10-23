import type { PushPayload } from "@civfix/seams"

export function N(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
}

export const N1 = N(1)
export const N2 = N(2)

export function P(notificationId: string, category: string | null): PushPayload {
  return {
    title: "Status changed",
    body: "Your report is in progress",
    link: "/reports/r1",
    notificationId,
    category,
    data: { type: "report_update" },
  }
}

export function MAP(notificationId: string, category: string | null): Record<string, string> {
  return {
    kind: "notification",
    notificationId,
    type: "report_update",
    ...(category !== null ? { category } : {}),
    link: "/reports/r1",
  }
}
