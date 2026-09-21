export interface ForwardTemplateSettingsRecord {
  subjectTemplate: string | null
  bodyTemplate: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface SetForwardTemplateInput {
  subjectTemplate: string | null
  bodyTemplate: string | null
  actorId: string | null
}

export interface ForwardTemplateRepository {
  get(): Promise<ForwardTemplateSettingsRecord | null>
  set(input: SetForwardTemplateInput): Promise<ForwardTemplateSettingsRecord>
}

export type ForwardTemplateReader = Pick<ForwardTemplateRepository, "get">
