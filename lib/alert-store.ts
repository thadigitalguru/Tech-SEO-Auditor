import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Prisma } from '@/app/generated/prisma/client'

import { type LighthouseScores } from './audit-engine'
import { getAuditReport, getAuditReportsByTargetUrl, type StoredAudit } from './audit-store'
import { prisma } from './db'
import { deliverAlertNotification, validateDeliveryTarget } from './alert-notifications'

export interface ScoreAlertRule {
  id: string
  targetUrl: string
  dropPoints: number
  active: boolean
  deliveryChannel: AlertDeliveryChannel
  deliveryTarget: string | null
  cooldownHours: number
  createdAt: Date
  updatedAt: Date
  userId: string | null
}

export type AlertDeliveryChannel = 'webhook' | 'email'
export type AlertDeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped'

export interface ScoreAlertEvent {
  id: string
  ruleId: string
  auditId: string
  previousAuditId: string | null
  targetUrl: string
  metricKey: ScoreMetricKey
  metricLabel: string
  previousScore: number
  currentScore: number
  delta: number
  deliveryChannel: AlertDeliveryChannel | null
  deliveryTarget: string | null
  deliveryStatus: AlertDeliveryStatus | null
  deliveryError: string | null
  deliveredAt: Date | null
  createdAt: Date
  userId: string | null
}

export interface SaveScoreAlertRuleInput {
  auditId?: string
  targetUrl?: string
  dropPoints: number
  active?: boolean
  deliveryChannel?: AlertDeliveryChannel
  deliveryTarget?: string | null
  cooldownHours?: number
  userId?: string | null
}

export interface AlertHistoryResult {
  rule: ScoreAlertRule | null
  events: ScoreAlertEvent[]
}

export type ScoreMetricKey = keyof LighthouseScores

const localStorePath = path.join(os.tmpdir(), 'tec-seo-auditor-alerts.json')

export async function saveScoreAlertRule(
  input: SaveScoreAlertRuleInput,
): Promise<ScoreAlertRule> {
  const targetUrl = await resolveTargetUrl(input)
  const dropPoints = clampInt(input.dropPoints, 1, 50, 5)
  const active = input.active ?? true
  const deliveryChannel = normalizeDeliveryChannel(input.deliveryChannel)
  const deliveryTarget = normalizeDeliveryTarget(input.deliveryTarget)
  const cooldownHours = clampInt(input.cooldownHours, 0, 168, 24)
  const deliveryTargetError = validateDeliveryTarget(deliveryChannel, deliveryTarget ?? '')
  if (deliveryTargetError) {
    throw new Error(deliveryTargetError)
  }
  const record = {
    targetUrl,
    dropPoints,
    active,
    deliveryChannel,
    deliveryTarget,
    cooldownHours,
    userId: input.userId ?? null,
  }

  try {
    const existing = await prisma.scoreAlertRule.findFirst({
      where: {
        targetUrl,
        userId: input.userId ?? null,
      },
    })

    const saved = existing
      ? await prisma.scoreAlertRule.update({
          where: { id: existing.id },
          data: record,
        })
      : await prisma.scoreAlertRule.create({
          data: record satisfies Prisma.ScoreAlertRuleCreateInput,
        })

    const normalized = normalizeRule(saved)
    await upsertLocalRule(normalized)

    return normalized
  } catch {
    const fallback: ScoreAlertRule = {
      id: cryptoRandomId(),
      targetUrl,
      dropPoints,
      active,
      deliveryChannel,
      deliveryTarget,
      cooldownHours,
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: input.userId ?? null,
    }

    await upsertLocalRule(fallback)
    return fallback
  }
}

export async function getScoreAlertRules(userId: string | null = null): Promise<ScoreAlertRule[]> {
  try {
    const rules = await prisma.scoreAlertRule.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    })

    if (rules.length > 0) {
      return rules.map(normalizeRule)
    }
  } catch {
    // Fall through to local store.
  }

  return (await readLocalState()).rules
    .filter((rule) => rule.userId === userId)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
}

export async function getScoreAlertRulesForTargetUrl(
  targetUrl: string,
  userId: string | null = null,
): Promise<ScoreAlertRule[]> {
  const rules = await getScoreAlertRules(userId)
  return rules.filter((rule) => rule.targetUrl === targetUrl)
}

export async function getScoreAlertEventsForTargetUrl(
  targetUrl: string,
  userId: string | null = null,
  limit = 10,
): Promise<ScoreAlertEvent[]> {
  try {
    const events = await prisma.scoreAlertEvent.findMany({
      where: {
        targetUrl,
        userId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    if (events.length > 0) {
      return events.map(normalizeEvent)
    }
  } catch {
    // Fall through to local store.
  }

  return (await readLocalState()).events
    .filter((event) => event.targetUrl === targetUrl)
    .filter((event) => event.userId === userId)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, limit)
}

export async function recordScoreDropAlerts(
  audit: StoredAudit,
  userId: string | null = null,
): Promise<ScoreAlertEvent[]> {
  const [rule] = await getScoreAlertRulesForTargetUrl(audit.results.targetUrl, userId)

  if (!rule || !rule.active) {
    return []
  }

  const previousAudits = await getAuditReportsByTargetUrl(audit.results.targetUrl, userId, 2)
  const previousAudit = previousAudits.find((entry) => entry.id !== audit.id) ?? null

  if (!previousAudit) {
    return []
  }

  const currentScores = audit.results.lighthouse.scores
  const previousScores = previousAudit.results.lighthouse.scores
  const comparisons = buildScoreComparisons(previousScores, currentScores)
  const triggered = comparisons.filter((comparison) => comparison.delta <= -rule.dropPoints)

  if (triggered.length === 0) {
    return []
  }

  const recentEvents = await getScoreAlertEventsForRuleId(rule.id, userId, 20)
  const draftedEvents = triggered
    .filter((comparison) =>
      !shouldSkipEvent(rule, comparison.metricKey, audit.id, audit.createdAt, recentEvents),
    )
    .map((comparison) => ({
    id: cryptoRandomId(),
    ruleId: rule.id,
    auditId: audit.id,
    previousAuditId: previousAudit.id,
    targetUrl: audit.results.targetUrl,
    metricKey: comparison.metricKey,
    metricLabel: comparison.metricLabel,
    previousScore: comparison.previousScore,
    currentScore: comparison.currentScore,
    delta: comparison.delta,
    deliveryChannel: rule.deliveryChannel,
    deliveryTarget: rule.deliveryTarget,
    deliveryStatus: 'queued' as const,
    deliveryError: null,
    deliveredAt: null,
    createdAt: new Date(),
    userId,
    }))

  if (draftedEvents.length === 0) {
    return []
  }

  const events = await deliverAlertEvents(rule, draftedEvents)
  await saveAlertEvents(events)
  return events
}

export async function getAlertHistoryForTargetUrl(
  targetUrl: string,
  userId: string | null = null,
): Promise<AlertHistoryResult> {
  const [rule, events] = await Promise.all([
    getScoreAlertRulesForTargetUrl(targetUrl, userId).then((rules) => rules[0] ?? null),
    getScoreAlertEventsForTargetUrl(targetUrl, userId, 1000),
  ])

  return { rule, events }
}

export async function getScoreAlertEventsForRuleId(
  ruleId: string,
  userId: string | null = null,
  limit = 20,
): Promise<ScoreAlertEvent[]> {
  try {
    const events = await prisma.scoreAlertEvent.findMany({
      where: { ruleId, userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    if (events.length > 0) {
      return events.map(normalizeEvent)
    }
  } catch {
    // Fall through to local store.
  }

  return (await readLocalState()).events
    .filter((event) => event.ruleId === ruleId)
    .filter((event) => event.userId === userId)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, limit)
}

export async function getAlertHistoryPageForTargetUrl(
  targetUrl: string,
  userId: string | null = null,
  query: {
    metric?: string
    status?: string
    page?: number
    pageSize?: number
  } = {},
) {
  const pageSize = clampInt(query.pageSize, 1, 50, 10)
  const page = clampInt(query.page, 1, 1000, 1)
  const { rule, events } = await getAlertHistoryForTargetUrl(targetUrl, userId)
  const filtered = events.filter((event) => {
    const metricMatch = !query.metric || event.metricKey === query.metric
    const statusMatch = !query.status || event.deliveryStatus === query.status
    return metricMatch && statusMatch
  })
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize

  return {
    rule,
    events: filtered.slice(start, start + pageSize),
    metric: query.metric ?? '',
    status: query.status ?? '',
    page: currentPage,
    pageSize,
    total,
    totalPages,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
  }
}

async function saveAlertEvents(events: ScoreAlertEvent[]) {
  if (events.length === 0) {
    return
  }

  try {
    await prisma.scoreAlertEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        ruleId: event.ruleId,
        auditId: event.auditId,
        previousAuditId: event.previousAuditId,
        targetUrl: event.targetUrl,
        metricKey: event.metricKey,
        metricLabel: event.metricLabel,
        previousScore: event.previousScore,
        currentScore: event.currentScore,
        delta: event.delta,
        deliveryChannel: event.deliveryChannel,
        deliveryTarget: event.deliveryTarget,
        deliveryStatus: event.deliveryStatus,
        deliveryError: event.deliveryError,
        deliveredAt: event.deliveredAt,
        userId: event.userId,
      } satisfies Prisma.ScoreAlertEventCreateManyInput)),
    })

    const state = await readLocalState()
    await writeLocalState({
      rules: state.rules,
      events: [...state.events, ...events],
    })
  } catch {
    const state = await readLocalState()
    await writeLocalState({
      rules: state.rules,
      events: [...state.events, ...events],
    })
  }
}

async function deliverAlertEvents(
  rule: ScoreAlertRule,
  events: ScoreAlertEvent[],
): Promise<ScoreAlertEvent[]> {
  const nextEvents: ScoreAlertEvent[] = []

  for (const event of events) {
    const delivery = await deliverAlertNotification(rule, event)
    nextEvents.push({
      ...event,
      deliveryStatus: delivery.status,
      deliveryError: delivery.error,
      deliveredAt: delivery.deliveredAt,
    })
  }

  return nextEvents
}

async function upsertLocalRule(rule: ScoreAlertRule) {
  const state = await readLocalState()
  const nextRules = [
    ...state.rules.filter((entry) => entry.id !== rule.id && !(entry.targetUrl === rule.targetUrl && entry.userId === rule.userId)),
    rule,
  ]

  await writeLocalState({
    rules: nextRules,
    events: state.events,
  })
}

async function resolveTargetUrl(input: SaveScoreAlertRuleInput) {
  if (input.targetUrl) {
    return normalizeTargetUrl(input.targetUrl)
  }

  if (input.auditId) {
    const audit = await getAuditReport(input.auditId)
    if (audit) {
      return normalizeTargetUrl(audit.results.targetUrl)
    }
  }

  throw new Error('A saved audit URL is required.')
}

function buildScoreComparisons(
  previousScores: LighthouseScores,
  currentScores: LighthouseScores,
) {
  return [
    metricComparison('performance', 'Performance', previousScores.performance, currentScores.performance),
    metricComparison('accessibility', 'Accessibility', previousScores.accessibility, currentScores.accessibility),
    metricComparison('bestPractices', 'Best practices', previousScores.bestPractices, currentScores.bestPractices),
    metricComparison('seo', 'SEO', previousScores.seo, currentScores.seo),
  ]
}

function metricComparison(
  metricKey: ScoreMetricKey,
  metricLabel: string,
  previousScore: number,
  currentScore: number,
) {
  return {
    metricKey,
    metricLabel,
    previousScore,
    currentScore,
    delta: currentScore - previousScore,
  }
}

async function readLocalState(): Promise<AlertStoreState> {
  try {
    const raw = await fs.readFile(localStorePath, 'utf8')
    const parsed = JSON.parse(raw) as SerializedAlertStoreState
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRuleFromSerialized) : [],
      events: Array.isArray(parsed.events) ? parsed.events.map(normalizeEventFromSerialized) : [],
    }
  } catch {
    return { rules: [], events: [] }
  }
}

async function writeLocalState(state: AlertStoreState) {
  const serialized: SerializedAlertStoreState = {
    rules: state.rules.map(serializeRule),
    events: state.events.map(serializeEvent),
  }

  await fs.writeFile(localStorePath, JSON.stringify(serialized, null, 2), 'utf8')
}

function normalizeRule(rule: {
  id: string
  targetUrl: string
  dropPoints: number
  active: boolean
  deliveryChannel: string | null
  deliveryTarget: string | null
  cooldownHours?: number | null
  createdAt: Date
  updatedAt: Date
  userId: string | null
}): ScoreAlertRule {
  return {
    ...rule,
    deliveryChannel: normalizeDeliveryChannel(rule.deliveryChannel),
    deliveryTarget: normalizeDeliveryTarget(rule.deliveryTarget),
    cooldownHours: clampInt(rule.cooldownHours, 0, 168, 24),
  }
}

function normalizeRuleFromSerialized(rule: SerializedScoreAlertRule): ScoreAlertRule {
  return {
    ...rule,
    deliveryChannel: normalizeDeliveryChannel(rule.deliveryChannel),
    deliveryTarget: normalizeDeliveryTarget(rule.deliveryTarget),
    cooldownHours: clampInt(rule.cooldownHours, 0, 168, 24),
    createdAt: new Date(rule.createdAt),
    updatedAt: new Date(rule.updatedAt),
  }
}

function serializeRule(rule: ScoreAlertRule): SerializedScoreAlertRule {
  return {
    ...rule,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  }
}

function normalizeEvent(event: {
  id: string
  ruleId: string
  auditId: string
  previousAuditId: string | null
  targetUrl: string
  metricKey: string
  metricLabel: string
  previousScore: number
  currentScore: number
  delta: number
  deliveryChannel: string | null
  deliveryTarget: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  deliveredAt: Date | null
  createdAt: Date
  userId: string | null
}): ScoreAlertEvent {
  return {
    ...event,
    metricKey: event.metricKey as ScoreMetricKey,
    deliveryChannel: normalizeDeliveryChannel(event.deliveryChannel),
    deliveryTarget: normalizeDeliveryTarget(event.deliveryTarget),
    deliveryStatus: normalizeDeliveryStatus(event.deliveryStatus),
    deliveryError: event.deliveryError ?? null,
    deliveredAt: event.deliveredAt,
  }
}

function normalizeEventFromSerialized(event: SerializedScoreAlertEvent): ScoreAlertEvent {
  return {
    ...event,
    metricKey: event.metricKey as ScoreMetricKey,
    deliveryChannel: normalizeDeliveryChannel(event.deliveryChannel),
    deliveryTarget: normalizeDeliveryTarget(event.deliveryTarget),
    deliveryStatus: normalizeDeliveryStatus(event.deliveryStatus),
    deliveryError: event.deliveryError ?? null,
    deliveredAt: event.deliveredAt ? new Date(event.deliveredAt) : null,
    createdAt: new Date(event.createdAt),
  }
}

function serializeEvent(event: ScoreAlertEvent): SerializedScoreAlertEvent {
  return {
    ...event,
    deliveryChannel: event.deliveryChannel,
    deliveryTarget: event.deliveryTarget,
    deliveryStatus: event.deliveryStatus,
    deliveryError: event.deliveryError,
    deliveredAt: event.deliveredAt ? event.deliveredAt.toISOString() : null,
    createdAt: event.createdAt.toISOString(),
  }
}

function normalizeTargetUrl(value: string) {
  const targetUrl = new URL(value)
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${targetUrl.protocol}`)
  }

  return targetUrl.href
}

function clampInt(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  if (value === null || value === undefined) {
    return fallback
  }

  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.trunc(numericValue)))
}

function cryptoRandomId() {
  return `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

interface AlertStoreState {
  rules: ScoreAlertRule[]
  events: ScoreAlertEvent[]
}

interface SerializedAlertStoreState {
  rules: SerializedScoreAlertRule[]
  events: SerializedScoreAlertEvent[]
}

interface SerializedScoreAlertRule extends Omit<ScoreAlertRule, 'createdAt' | 'updatedAt'> {
  createdAt: string
  updatedAt: string
}

interface SerializedScoreAlertEvent extends Omit<ScoreAlertEvent, 'createdAt' | 'deliveredAt'> {
  createdAt: string
  deliveredAt: string | null
}

function normalizeDeliveryChannel(value: string | null | undefined): AlertDeliveryChannel {
  return value === 'email' ? 'email' : 'webhook'
}

function normalizeDeliveryTarget(value: string | null | undefined) {
  const target = typeof value === 'string' ? value.trim() : ''
  return target ? target : null
}

function normalizeDeliveryStatus(value: string | null | undefined): AlertDeliveryStatus | null {
  if (value === 'queued' || value === 'sent' || value === 'failed' || value === 'skipped') {
    return value
  }

  return null
}

function shouldSkipEvent(
  rule: ScoreAlertRule,
  metricKey: ScoreMetricKey,
  auditId: string,
  currentAuditTime: Date,
  events: ScoreAlertEvent[],
) {
  const cooldownMs = rule.cooldownHours * 60 * 60 * 1000
  const currentTime = currentAuditTime.getTime()

  return events.some((event) => {
    if (event.metricKey !== metricKey) {
      return false
    }

    if (event.auditId === auditId) {
      return true
    }

    if (cooldownMs === 0) {
      return false
    }

    return currentTime - event.createdAt.getTime() < cooldownMs
  })
}
