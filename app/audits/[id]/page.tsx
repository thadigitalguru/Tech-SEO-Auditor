import { notFound } from 'next/navigation'
import Link from 'next/link'

import { getAlertHistoryForTargetUrl } from '@/lib/alert-engine'
import { getAuditReport, getAuditReportsByTargetUrl, getRecentAudits } from '@/lib/audit-store'
import { buildAlertTrendSeries, buildAuditTrendSeries } from '@/lib/audit-trends'
import { summarizeAlertDelivery } from '@/lib/alert-notifications'
import { getScheduledAuditRunsForTargetUrl, getScheduledAuditsForTargetUrl } from '@/lib/schedule-store'
import { AlertControls } from './alert-controls'
import { ShareActions } from './share-actions'
import { ScheduleControls } from './schedule-controls'
import { TrendCharts } from './trend-charts'

function formatScore(value: number) {
  return `${value}%`
}

function formatMetric(value: number | null) {
  return value === null ? 'n/a' : value.toString()
}

function signalTone(status: 'pass' | 'warn' | 'fail') {
  if (status === 'pass') {
    return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-200'
  }

  if (status === 'fail') {
    return 'border-rose-300/30 bg-rose-400/10 text-rose-200'
  }

  return 'border-amber-300/30 bg-amber-400/10 text-amber-200'
}

export default async function AuditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const audit = await getAuditReport(id)
  const comparisonOptions = (await getRecentAudits(12)).filter((entry) => entry.id !== id)

  if (!audit) {
    notFound()
  }

  const report = audit.results
  const schedules = await getScheduledAuditsForTargetUrl(report.targetUrl, audit.userId)
  const alertHistory = await getAlertHistoryForTargetUrl(report.targetUrl, audit.userId)
  const recentRuns = await getScheduledAuditRunsForTargetUrl(report.targetUrl, audit.userId, 5)
  const auditTrend = buildAuditTrendSeries(
    await getAuditReportsByTargetUrl(report.targetUrl, audit.userId, 8),
  )
  const alertTrend = buildAlertTrendSeries(alertHistory.events, 8)
  const latestAlert = alertHistory.events[0] ?? null

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white sm:px-10 lg:px-16">
      <section className="mx-auto max-w-6xl space-y-8">
        <div>
          <Link
            href="/audits"
            className="text-sm font-medium text-cyan-300 hover:text-cyan-200"
          >
            Back to recent audits
          </Link>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-cyan-300">
            Audit dashboard
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            {report.targetUrl}
          </h1>
          <p className="max-w-3xl text-sm leading-7 text-slate-300">
            {report.summary.summary}
          </p>
          <ShareActions shareUrl={`/audits/${id}`} />
        </div>

        <ScheduleControls
          auditId={id}
          targetUrl={report.targetUrl}
          existingSchedule={schedules[0]
            ? {
                id: schedules[0].id,
                cadenceDays: schedules[0].cadenceDays,
                nextRunAt: schedules[0].nextRunAt.toISOString(),
                lastRunAt: schedules[0].lastRunAt ? schedules[0].lastRunAt.toISOString() : null,
                active: schedules[0].active,
              }
            : null}
          recentRuns={recentRuns.map((run) => ({
            id: run.id,
            auditId: run.auditId,
            status: run.status,
            error: run.error,
            runAt: run.runAt.toISOString(),
          }))}
        />

        <AlertControls
          auditId={id}
          targetUrl={report.targetUrl}
          existingRule={alertHistory.rule
            ? {
                id: alertHistory.rule.id,
                dropPoints: alertHistory.rule.dropPoints,
                active: alertHistory.rule.active,
                deliveryChannel: alertHistory.rule.deliveryChannel,
                deliveryTarget: alertHistory.rule.deliveryTarget,
                cooldownHours: alertHistory.rule.cooldownHours,
              }
            : null}
          recentEvents={alertHistory.events.map((event) => ({
            id: event.id,
            metricLabel: event.metricLabel,
            previousScore: event.previousScore,
            currentScore: event.currentScore,
            delta: event.delta,
            createdAt: event.createdAt.toISOString(),
            deliveryChannel: event.deliveryChannel,
            deliveryTarget: event.deliveryTarget,
            deliveryStatus: event.deliveryStatus,
            deliveryError: event.deliveryError,
          }))}
          latestDelivery={
            latestAlert && alertHistory.rule
              ? summarizeAlertDelivery(latestAlert, alertHistory.rule)
              : null
          }
        />

        <div className="flex flex-wrap gap-3">
          <Link
            href={`/audits/${id}/schedule`}
            className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 px-5 text-sm font-medium text-white transition-colors hover:border-cyan-300/60 hover:text-cyan-200"
          >
            Open schedule history
          </Link>
          <Link
            href={`/audits/${id}/alerts`}
            className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 px-5 text-sm font-medium text-white transition-colors hover:border-rose-300/60 hover:text-rose-200"
          >
            Open alert history
          </Link>
          <Link
            href={`/audits/${id}/trends/export`}
            className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 px-5 text-sm font-medium text-white transition-colors hover:border-cyan-300/60 hover:text-cyan-200"
          >
            Export trend JSON
          </Link>
          <Link
            href={`/audits/${id}/trends/export?format=csv`}
            className="inline-flex h-11 items-center justify-center rounded-full border border-white/15 px-5 text-sm font-medium text-white transition-colors hover:border-cyan-300/60 hover:text-cyan-200"
          >
            Export trend CSV
          </Link>
        </div>

        <TrendCharts scoreTrend={auditTrend} alertTrend={alertTrend} />

        {comparisonOptions.length > 0 ? (
          <form
            method="get"
            action={`/audits/${id}/compare`}
            className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/5 p-5 sm:flex-row sm:items-end"
          >
            <label className="flex-1">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                Compare with another report
              </span>
              <select
                name="to"
                defaultValue={comparisonOptions[0]?.id}
                className="h-12 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-sm text-white outline-none focus:border-cyan-300"
              >
                {comparisonOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.targetUrl || 'Untitled audit'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="h-12 rounded-2xl bg-cyan-300 px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-200"
            >
              Compare
            </button>
          </form>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['Performance', report.lighthouse.scores.performance],
            ['Accessibility', report.lighthouse.scores.accessibility],
            ['Best practices', report.lighthouse.scores.bestPractices],
            ['SEO', report.lighthouse.scores.seo],
          ].map(([label, score]) => (
            <article
              key={label}
              className="rounded-2xl border border-white/10 bg-white/5 p-5"
            >
              <p className="text-sm uppercase tracking-[0.24em] text-slate-400">
                {label}
              </p>
              <p className="mt-3 text-4xl font-semibold text-white">
                {formatScore(score as number)}
              </p>
            </article>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <article className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-semibold text-white">Priorities</h2>
            <div className="mt-5 space-y-4">
              {report.summary.priorities.map((priority) => (
                <section key={priority.title} className="rounded-2xl bg-slate-950/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold text-white">{priority.title}</h3>
                    <span className="rounded-full border border-cyan-300/30 px-3 py-1 text-xs uppercase tracking-[0.2em] text-cyan-200">
                      {priority.impact}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{priority.reason}</p>
                </section>
              ))}
            </div>
          </article>

          <article className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-semibold text-white">Signals</h2>
            <div className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Pages crawled</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{report.crawl.pages.length}</p>
                </div>
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Internal URLs discovered</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{report.crawl.discoveredUrls.length}</p>
                </div>
              </div>

              <div className="space-y-3">
                {(report.signals ?? []).map((signal) => (
                  <div key={signal.key} className="rounded-2xl bg-slate-950/60 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-white">{signal.label}</h3>
                      <span className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.2em] ${signalTone(signal.status)}`}>
                        {signal.status}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-300">{signal.detail}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">LCP</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{formatMetric(report.lighthouse.metrics.lcp)}</p>
                </div>
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">CLS</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{formatMetric(report.lighthouse.metrics.cls)}</p>
                </div>
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">INP</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{formatMetric(report.lighthouse.metrics.inp)}</p>
                </div>
                <div className="rounded-2xl bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">TBT</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{formatMetric(report.lighthouse.metrics.tbt)}</p>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>
    </main>
  )
}
