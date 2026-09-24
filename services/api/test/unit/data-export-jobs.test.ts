import { describe, it, expect, vi } from "vitest"
import { AppError, ErrorCode, MailSendError } from "@civfix/shared"
import { FakeJobs } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import type { DataExportService } from "../../src/services/data-export-service.js"
import {
  registerDataExportJobs,
  runDataExport,
  type DataExportJobLogger,
} from "../../src/services/data-export-jobs.js"
import { DATA_EXPORT_JOB } from "../../src/lib/queue-names.js"

// BE-TEST-049. The job's retry contract: a transient infra failure must rethrow so pg-boss retries it,
// while a permanent delivery failure must complete the job, or pg-boss would re-send the whole export
// on every retry.

const USER_ID = "11111111-1111-1111-1111-111111111111"

function serviceThat(exportData: DataExportService["exportData"]): DataExportService {
  return { exportData: vi.fn(exportData), recordUndeliverable: vi.fn(async () => {}) }
}

function recordingLogger(): DataExportJobLogger & {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn() }
}

describe("runDataExport (BE-TEST-049)", () => {
  it("resolves quietly when the export was delivered", async () => {
    const logger = recordingLogger()
    const service = serviceThat(async () => ({ ok: true, email: "jane@example.com" }))
    await expect(runDataExport(service, USER_ID, logger)).resolves.toBeUndefined()
    expect(service.exportData).toHaveBeenCalledWith(USER_ID)
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("logs info and resolves when the account has no delivery channel ({ email: null })", async () => {
    const logger = recordingLogger()
    const service = serviceThat(async () => ({ ok: true, email: null }))
    await expect(runDataExport(service, USER_ID, logger)).resolves.toBeUndefined()
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      { userId: USER_ID },
      "data.export skip: no delivery channel",
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("rethrows a plain Error as transient and logs the retry", async () => {
    const logger = recordingLogger()
    const err = new Error("connection reset")
    const service = serviceThat(async () => {
      throw err
    })
    await expect(runDataExport(service, USER_ID, logger)).rejects.toBe(err)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { err, userId: USER_ID },
      "data.export transient failure (retrying)",
    )
  })

  it("rethrows AppError INTERNAL as transient", async () => {
    const logger = recordingLogger()
    const err = new AppError(ErrorCode.INTERNAL, "smtp auth failed")
    const service = serviceThat(async () => {
      throw err
    })
    await expect(runDataExport(service, USER_ID, logger)).rejects.toBe(err)
    expect(logger.warn).toHaveBeenCalledWith(
      { err, userId: USER_ID },
      "data.export transient failure (retrying)",
    )
  })

  it("rethrows AppError RATE_LIMITED as transient", async () => {
    const logger = recordingLogger()
    const err = new AppError(ErrorCode.RATE_LIMITED, "slow down")
    const service = serviceThat(async () => {
      throw err
    })
    await expect(runDataExport(service, USER_ID, logger)).rejects.toBe(err)
    expect(logger.warn).toHaveBeenCalledWith(
      { err, userId: USER_ID },
      "data.export transient failure (retrying)",
    )
  })

  it("completes the job on MailSendError(CONFLICT) and logs it as a permanent failure", async () => {
    const logger = recordingLogger()
    const err = new MailSendError(ErrorCode.CONFLICT, "message too large", {})
    const service = serviceThat(async () => {
      throw err
    })
    await expect(runDataExport(service, USER_ID, logger)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { err, userId: USER_ID },
      "data.export failed (completing job)",
    )
    expect(logger.info).not.toHaveBeenCalled()
  })

  it("works with no logger at all", async () => {
    const service = serviceThat(async () => ({ ok: true, email: null }))
    await expect(runDataExport(service, USER_ID)).resolves.toBeUndefined()
    const failing = serviceThat(async () => {
      throw new Error("boom")
    })
    await expect(runDataExport(failing, USER_ID)).rejects.toThrow("boom")
  })
})

describe("registerDataExportJobs (BE-TEST-049)", () => {
  function harness(): {
    jobs: FakeJobs
    makeService: ReturnType<typeof vi.fn>
    exportData: ReturnType<typeof vi.fn>
    container: Container
  } {
    const jobs = new FakeJobs()
    const exportData = vi.fn(async () => ({ ok: true as const, email: "jane@example.com" }))
    const makeService = vi.fn(
      (): DataExportService => ({ exportData, recordUndeliverable: vi.fn(async () => {}) }),
    )
    const container = { jobs } as unknown as Container
    return { jobs, makeService, exportData, container }
  }

  it("registers a worker on the data.export queue", async () => {
    const { jobs, makeService, container } = harness()
    await registerDataExportJobs(container, { makeService })
    expect(DATA_EXPORT_JOB).toBe("data.export")
    await jobs.enqueue(DATA_EXPORT_JOB, { userId: USER_ID })
    expect(makeService).toHaveBeenCalledTimes(1)
    expect(makeService).toHaveBeenCalledWith(container)
  })

  it("builds the service and exports for a job carrying a userId", async () => {
    const { jobs, makeService, exportData, container } = harness()
    await registerDataExportJobs(container, { makeService })
    await jobs.enqueue(DATA_EXPORT_JOB, { userId: USER_ID })
    expect(exportData).toHaveBeenCalledWith(USER_ID)
    expect(jobs.jobsFor(DATA_EXPORT_JOB)[0]!.state).toBe("completed")
  })

  it.each([
    ["an empty payload", {}],
    ["an empty userId", { userId: "" }],
    ["a non-string userId", { userId: 42 }],
    ["a null payload", null],
  ])("completes %s without ever building the service", async (_label, data) => {
    const { jobs, makeService, exportData, container } = harness()
    await registerDataExportJobs(container, { makeService })
    await jobs.enqueue(DATA_EXPORT_JOB, data)
    expect(makeService).not.toHaveBeenCalled()
    expect(exportData).not.toHaveBeenCalled()
    expect(jobs.jobsFor(DATA_EXPORT_JOB)[0]!.state).toBe("completed")
  })

  it("fails the job (so pg-boss retries) when the export throws a transient error", async () => {
    const { jobs, container } = harness()
    const err = new Error("db down")
    await registerDataExportJobs(container, {
      makeService: () =>
        serviceThat(async () => {
          throw err
        }),
    })
    await jobs.enqueue(DATA_EXPORT_JOB, { userId: USER_ID })
    const job = jobs.jobsFor(DATA_EXPORT_JOB)[0]!
    expect(job.state).toBe("failed")
    expect(job.error).toBe(err)
  })
})
