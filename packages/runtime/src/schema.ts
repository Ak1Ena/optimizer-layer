import { z } from 'zod';
import type { ContextAssessment, Event, Measurement } from './types.ts';

const text = z.string().trim().min(1).max(200_000);
const id = z.string().min(1).max(256);
const timestamp = z.string().datetime({ offset: true });
const resolution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open') }).strict(),
  z.object({ kind: z.literal('resolved'), answer: text, source: text }).strict(),
]);
const requirement = z.object({ id, statement: text, acceptance: z.string(), sourceLine: z.number().int().positive() }).strict();
const uncertainty = z.object({ id, question: text, owner: z.enum(['human', 'local']), critical: z.boolean(), resolution }).strict();
const goal = z.object({ version: z.number().int().positive().default(1), request: text, requirements: z.array(requirement).min(1), uncertainties: z.array(uncertainty) }).strict();
const reviewFields = { goalVersion: z.number().int().positive(), rationale: text, itemIds: z.array(id).min(1) };
const acceptReview = z.object({ kind: z.literal('accept'), ...reviewFields }).strict();
const challengeReview = z.object({ kind: z.literal('challenge'), ...reviewFields, requirementId: id, owner: z.enum(['human', 'local']) }).strict();
const reviewResponse = z.discriminatedUnion('kind', [acceptReview, challengeReview]);
const recordedReview = z.discriminatedUnion('kind', [
  acceptReview.extend({ kind: z.literal('accepted') }),
  challengeReview.extend({ kind: z.literal('challenged'), uncertaintyId: id }),
]);
const contractReview = z.union([z.object({ kind: z.literal('pending') }).strict(), recordedReview]);
export type ReviewResponse = z.infer<typeof reviewResponse>;
export type ContractReview = z.infer<typeof contractReview>;
const checkDefinition = z.object({
  id, requirementIds: z.array(id).min(1), argv: z.tuple([text]).rest(z.string().max(100_000)),
  timeoutMs: z.number().int().min(10).max(30_000),
}).strict();
const checkSchema = checkDefinition.extend({
  artifacts: z.array(z.object({ path: text, digest: text }).strict()).default([]),
});
const checkRegistration = checkDefinition.extend({ artifactFiles: z.array(text).default([]) });
const decision = z.object({ id, text, source: text, line: z.number().int().positive(), digest: text, timestamp, role: z.literal('user'), supersedes: z.array(id) }).strict();
const item = z.object({
  id, kind: z.enum(['code', 'document', 'decision']), path: text, line: z.number().int().positive(), excerpt: text,
  digest: text, retrievedAt: timestamp, requirementIds: z.array(id), authority: z.enum(['untrusted', 'user-decision']),
}).strict();
const context = z.object({ items: z.array(item), uncoveredRequirementIds: z.array(id), diagnostics: z.array(z.string()), complete: z.boolean(), projectDigest: z.string() }).strict();
const assessment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sufficient'), rationale: text, itemIds: z.array(id).min(1) }).strict(),
  z.object({ kind: z.literal('insufficient'), rationale: text, itemIds: z.array(id) }).strict(),
]);
const control = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running'), rounds: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('paused'), rounds: z.number().int().nonnegative(), reason: text }).strict(),
  z.object({ kind: z.literal('escalated'), rounds: z.number().int().nonnegative(), reason: text }).strict(),
]);
const result = z.object({
  argv: z.array(z.string()).min(1), outcome: z.enum(['passed', 'failed', 'timeout', 'spawn-error', 'output-limit']),
  exitCode: z.number().int().nullable(), output: z.string().max(65_536), outputDigest: text, durationMs: z.number().nonnegative(),
}).strict();
const evidence = z.object({ checkId: id, requirementIds: z.array(id), projectDigest: text, result, at: timestamp }).strict();
const streak = z.object({ signature: z.string(), count: z.number().int().nonnegative() }).strict();
const state = z.object({
  id, goal, checks: z.array(checkSchema), decisions: z.array(decision), context: context.nullable(), assessment: assessment.nullable(),
  review: contractReview.default({ kind: 'pending' }),
  control, evidence: z.array(evidence), failureStreak: streak, completionClaimed: z.boolean(),
}).strict();
const payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session.started'), state }).strict(),
  z.object({ kind: z.literal('conversation.imported'), decisions: z.array(decision) }).strict(),
  z.object({ kind: z.literal('context.retrieved'), context }).strict(),
  z.object({ kind: z.literal('context.assessed'), assessment }).strict(),
  z.object({ kind: z.literal('contract.reviewed'), review: recordedReview }).strict(),
  z.object({ kind: z.literal('contract.escalated'), reason: text, review: challengeReview }).strict(),
  z.object({ kind: z.literal('uncertainty.resolved'), uncertaintyId: id, answer: text, source: text }).strict(),
  z.object({ kind: z.literal('command.observed'), evidence, control, failureStreak: streak }).strict(),
  z.object({ kind: z.literal('strategy.resolved'), rationale: text, strategy: z.enum(['retain', 'revise']), control }).strict(),
  z.object({ kind: z.literal('completion.claimed') }).strict(),
  z.object({ kind: z.literal('session.replaced'), replacedBy: id }).strict(),
]);
const event = z.object({ version: z.literal(1), id, sessionId: id, producer: id, at: timestamp, payload }).strict();

const projectConfig = z.object({
  enabled: z.boolean(), hookToken: z.string().regex(/^[0-9a-f]{64}$/), checks: z.array(checkSchema).min(1).max(100), activeSessionId: id.nullable(),
}).strict();
export type ProjectConfig = z.infer<typeof projectConfig>;

export function parseEvent(input: unknown): Event { return event.parse(input); }
export function parseChecks(input: unknown) { return z.array(checkRegistration).max(100).parse(input); }
export function parseProjectConfig(input: unknown): ProjectConfig { return projectConfig.parse(input); }
export function parseAssessment(input: unknown): ContextAssessment { return assessment.parse(input); }
export function parseReviewResponse(input: unknown): ReviewResponse { return reviewResponse.parse(input); }
export function parseMeasurement(input: unknown): Measurement {
  return z.object({ operation: text, elapsedMs: z.number().nonnegative(), externalMs: z.number().nonnegative(), optimizerMs: z.number().nonnegative(), at: timestamp }).strict().parse(input);
}
export function nonempty(input: string, name: string): string {
  if (!input.trim()) throw new Error(`${name} must not be empty`);
  return input.trim();
}
