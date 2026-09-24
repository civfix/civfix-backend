import { AppError, MAX_EVENT_QUESTIONS } from "@civfix/shared"
import type {
  ListEventQuestionsRequest,
  ListEventQuestionsResponse,
  SaveEventQuestionsRequest,
  SaveEventQuestionsResponse,
} from "@civfix/shared"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import { toEventQuestionDTO } from "./registration-dto.js"
import type { DesiredQuestion, HostRegistrationRepository } from "./registration-repository.js"

export interface QuestionServiceDeps {
  repo: HostRegistrationRepository
  now?: () => Date
}

export interface QuestionViewer {
  canManage: boolean
}

export interface QuestionService {
  list(
    query: ListEventQuestionsRequest,
    viewer: QuestionViewer,
  ): Promise<ListEventQuestionsResponse>
  save(input: SaveEventQuestionsRequest): Promise<SaveEventQuestionsResponse>
}

export function makeQuestionService(deps: QuestionServiceDeps): QuestionService {
  const now = deps.now ?? (() => new Date())

  return {
    async list(query, viewer): Promise<ListEventQuestionsResponse> {
      const records = await deps.repo.listQuestions(query.id, {
        ...(query.ticketTypeId !== undefined ? { ticketTypeId: query.ticketTypeId } : {}),
      })
      if (viewer.canManage || records.every((record) => record.ticketTypeId === null)) {
        return { items: records.map(toEventQuestionDTO) }
      }
      // A hidden type is host-assigned only; its questions would publish its id to anyone.
      const types = await deps.repo.listTicketTypes(query.id)
      const hidden = new Set(types.filter((t) => t.visibility === "hidden").map((t) => t.id))
      return {
        items: records
          .filter((record) => record.ticketTypeId === null || !hidden.has(record.ticketTypeId))
          .map(toEventQuestionDTO),
      }
    },

    async save(input): Promise<SaveEventQuestionsResponse> {
      if (input.questions.length > MAX_EVENT_QUESTIONS) {
        throw AppError.validation({
          questions: `an event can ask at most ${MAX_EVENT_QUESTIONS} questions`,
        })
      }

      const seen = new Set<string>()
      const desired: DesiredQuestion[] = input.questions.map((question, index) => {
        assertNoSlur(question.prompt, "prompt")
        if (question.helpText != null) assertNoSlur(question.helpText, "helpText")
        if (question.id !== undefined) {
          if (seen.has(question.id)) {
            throw AppError.validation({ questions: "the same question id appears twice" })
          }
          seen.add(question.id)
        }
        return {
          id: question.id ?? null,
          ticketTypeId: question.ticketTypeId ?? null,
          kind: question.kind,
          prompt: question.prompt,
          helpText: question.helpText ?? null,
          required: question.required,
          options: "options" in question ? question.options : [],
          maxSelections: question.kind === "multi_select" ? (question.maxSelections ?? null) : null,
          consentText: question.kind === "consent" ? question.consentText : null,
          showIf: question.showIf ?? null,
          sortOrder: question.sortOrder ?? index,
        }
      })

      const conditionTargets = new Set(
        desired.map((q) => q.id).filter((id): id is string => id !== null),
      )
      for (const question of desired) {
        if (question.showIf !== null && !conditionTargets.has(question.showIf.questionId)) {
          throw AppError.validation({
            showIf: "must reference another question kept in this same save",
          })
        }
      }

      const typeIds = desired.map((q) => q.ticketTypeId).filter((id): id is string => id !== null)
      if (typeIds.length > 0) {
        const own = new Set((await deps.repo.listTicketTypes(input.id)).map((type) => type.id))
        if (typeIds.some((id) => !own.has(id))) {
          throw AppError.validation({ ticketTypeId: "not a ticket type on this event" })
        }
      }

      const records = await deps.repo.reconcileQuestions(input.id, desired, now())
      return { items: records.map(toEventQuestionDTO) }
    },
  }
}
