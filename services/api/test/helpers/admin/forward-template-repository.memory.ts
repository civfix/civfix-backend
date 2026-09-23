import type {
  ForwardTemplateRepository,
  ForwardTemplateSettingsRecord,
  SetForwardTemplateInput,
} from "../../../src/services/admin/forward-template-repository.js"

export class InMemoryForwardTemplateRepository implements ForwardTemplateRepository {
  record: ForwardTemplateSettingsRecord | null = null
  readonly writes: SetForwardTemplateInput[] = []
  now = new Date(Date.UTC(2026, 5, 6, 0, 0, 0, 0))

  seed(record: Partial<ForwardTemplateSettingsRecord>): ForwardTemplateSettingsRecord {
    this.record = {
      subjectTemplate: record.subjectTemplate ?? null,
      bodyTemplate: record.bodyTemplate ?? null,
      updatedAt: record.updatedAt ?? this.now,
      updatedBy: record.updatedBy ?? null,
    }
    return this.record
  }

  get(): Promise<ForwardTemplateSettingsRecord | null> {
    return Promise.resolve(this.record === null ? null : { ...this.record })
  }

  set(input: SetForwardTemplateInput): Promise<ForwardTemplateSettingsRecord> {
    this.writes.push(input)
    const record = this.seed({
      subjectTemplate: input.subjectTemplate,
      bodyTemplate: input.bodyTemplate,
      updatedAt: this.now,
      updatedBy: input.actorId,
    })
    return Promise.resolve({ ...record })
  }
}
