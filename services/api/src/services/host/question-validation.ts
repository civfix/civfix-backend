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

type AnswerCheck = { write: AnswerWrite } | { error: string }

type AnswerValue = EventAnswerInput["value"]

const REQUIRED = "required"

function checkTextAnswer(question: QuestionRecord, value: AnswerValue): AnswerCheck {
  if (typeof value !== "string") return { error: "must be text" }
  const trimmed = value.trim()
  const max = question.kind === "short_text" ? MAX_SHORT_TEXT_ANSWER : MAX_LONG_TEXT_ANSWER
  if (trimmed.length > max) return { error: `must be at most ${max} characters` }
  if (question.required && trimmed.length === 0) return { error: REQUIRED }
  return { write: { questionId: question.id, valueText: trimmed, valueJson: null } }
}

function checkSingleSelect(question: QuestionRecord, value: AnswerValue): AnswerCheck {
  if (typeof value !== "string" || !question.options.some((option) => option.value === value)) {
    return { error: "must be one of the offered options" }
  }
  return { write: { questionId: question.id, valueText: value, valueJson: null } }
}

function checkMultiSelect(question: QuestionRecord, value: AnswerValue): AnswerCheck {
  if (!Array.isArray(value)) return { error: "must be a list of offered options" }
  if (value.length > MAX_QUESTION_OPTIONS) return { error: "too many selections" }
  const allowed = new Set(question.options.map((option) => option.value))
  if (value.some((entry) => typeof entry !== "string" || !allowed.has(entry))) {
    return { error: "must be a list of offered options" }
  }
  if (new Set(value).size !== value.length) return { error: "lists the same option twice" }
  if (question.maxSelections !== null && value.length > question.maxSelections) {
    return { error: `select at most ${question.maxSelections}` }
  }
  if (question.required && value.length === 0) return { error: REQUIRED }
  return { write: { questionId: question.id, valueText: null, valueJson: value } }
}

function checkBooleanAnswer(question: QuestionRecord, value: AnswerValue): AnswerCheck {
  if (typeof value !== "boolean") return { error: "must be true or false" }
  if (question.required && !value) return { error: REQUIRED }
  return { write: { questionId: question.id, valueText: null, valueJson: value } }
}

function checkAnswer(question: QuestionRecord, value: AnswerValue): AnswerCheck {
  switch (question.kind) {
    case "short_text":
    case "long_text":
      return checkTextAnswer(question, value)
    case "single_select":
      return checkSingleSelect(question, value)
    case "multi_select":
      return checkMultiSelect(question, value)
    case "checkbox":
    case "consent":
      return checkBooleanAnswer(question, value)
  }
}

function indexSubmitted(
  live: ReadonlyMap<string, QuestionRecord>,
  answers: readonly EventAnswerInput[],
  fields: Record<string, string>,
): Map<string, EventAnswerInput> {
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
  return submitted
}

export function validateAnswers(
  questions: readonly QuestionRecord[],
  answers: readonly EventAnswerInput[],
): AnswerValidation {
  const fields: Record<string, string> = {}
  const live = new Map(questions.filter((q) => q.archivedAt === null).map((q) => [q.id, q]))
  const submitted = indexSubmitted(live, answers, fields)
  const writes: AnswerWrite[] = []

  for (const question of live.values()) {
    const answer = submitted.get(question.id)
    const applies = conditionSatisfied(question, submitted)

    if (answer === undefined) {
      if (question.required && applies) fields[question.id] = REQUIRED
      continue
    }
    if (!applies) {
      fields[question.id] = "not applicable to the other answers given"
      continue
    }

    const checked = checkAnswer(question, answer.value)
    if ("error" in checked) fields[question.id] = checked.error
    else writes.push(checked.write)
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields }
  return { ok: true, writes }
}
