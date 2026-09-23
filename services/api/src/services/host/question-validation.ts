import { MAX_LONG_TEXT_ANSWER, MAX_QUESTION_OPTIONS, MAX_SHORT_TEXT_ANSWER } from "@civfix/shared"
import type { EventAnswerInput } from "@civfix/shared"
import type { AnswerWrite, QuestionRecord } from "./registration-repository.types.js"

export type AnswerValidation =
  | { ok: true; writes: AnswerWrite[] }
  | { ok: false; fields: Record<string, string> }

function conditionSatisfied(
  question: QuestionRecord,
  byId: Map<string, EventAnswerInput>,
): boolean {
  const condition = question.showIf
  if (condition === null) return true
  const source = byId.get(condition.questionId)
  if (source === undefined) return false
  if (typeof condition.equals === "boolean") return source.value === condition.equals
  if (typeof source.value === "string") return source.value === condition.equals
  if (Array.isArray(source.value)) return source.value.includes(condition.equals)
  return false
}

export function validateAnswers(
  questions: readonly QuestionRecord[],
  answers: readonly EventAnswerInput[],
): AnswerValidation {
  const fields: Record<string, string> = {}
  const live = new Map(questions.filter((q) => q.archivedAt === null).map((q) => [q.id, q]))
  const submitted = new Map<string, EventAnswerInput>()

  for (const answer of answers) {
    if (!live.has(answer.questionId)) {
      fields[answer.questionId] = "unknown question"
      continue
    }
    if (submitted.has(answer.questionId)) {
      fields[answer.questionId] = "answered more than once"
      continue
    }
    submitted.set(answer.questionId, answer)
  }

  const writes: AnswerWrite[] = []

  for (const question of live.values()) {
    const answer = submitted.get(question.id)
    const applies = conditionSatisfied(question, submitted)

    if (answer === undefined) {
      if (question.required && applies) fields[question.id] = "required"
      continue
    }
    if (!applies) {
      fields[question.id] = "not applicable to the other answers given"
      continue
    }

    const value = answer.value
    switch (question.kind) {
      case "short_text":
      case "long_text": {
        if (typeof value !== "string") {
          fields[question.id] = "must be text"
          break
        }
        const trimmed = value.trim()
        const max = question.kind === "short_text" ? MAX_SHORT_TEXT_ANSWER : MAX_LONG_TEXT_ANSWER
        if (trimmed.length > max) {
          fields[question.id] = `must be at most ${max} characters`
          break
        }
        if (question.required && trimmed.length === 0) {
          fields[question.id] = "required"
          break
        }
        writes.push({ questionId: question.id, valueText: trimmed, valueJson: null })
        break
      }
      case "single_select": {
        if (typeof value !== "string") {
          fields[question.id] = "must be one of the offered options"
          break
        }
        if (!question.options.some((option) => option.value === value)) {
          fields[question.id] = "must be one of the offered options"
          break
        }
        writes.push({ questionId: question.id, valueText: value, valueJson: null })
        break
      }
      case "multi_select": {
        if (!Array.isArray(value)) {
          fields[question.id] = "must be a list of offered options"
          break
        }
        if (value.length > MAX_QUESTION_OPTIONS) {
          fields[question.id] = "too many selections"
          break
        }
        const allowed = new Set(question.options.map((option) => option.value))
        if (value.some((entry) => typeof entry !== "string" || !allowed.has(entry))) {
          fields[question.id] = "must be a list of offered options"
          break
        }
        if (new Set(value).size !== value.length) {
          fields[question.id] = "lists the same option twice"
          break
        }
        if (question.maxSelections !== null && value.length > question.maxSelections) {
          fields[question.id] = `select at most ${question.maxSelections}`
          break
        }
        if (question.required && value.length === 0) {
          fields[question.id] = "required"
          break
        }
        writes.push({ questionId: question.id, valueText: null, valueJson: value })
        break
      }
      case "checkbox":
      case "consent": {
        if (typeof value !== "boolean") {
          fields[question.id] = "must be true or false"
          break
        }
        if (question.required && !value) {
          fields[question.id] = "required"
          break
        }
        writes.push({ questionId: question.id, valueText: null, valueJson: value })
        break
      }
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields }
  return { ok: true, writes }
}
