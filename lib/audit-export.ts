import type { StoredAudit } from './audit-store'

export type AuditExportFormat = 'json' | 'csv'

export function formatAuditExportFilename(audit: StoredAudit, format: AuditExportFormat) {
  return `audit-${audit.id}.${format}`
}

export function serializeAuditAsCsv(audit: StoredAudit) {
  const report = audit.results
  const rows = [
    ['field', 'value'],
    ['id', audit.id],
    ['createdAt', audit.createdAt.toISOString()],
    ['targetUrl', report.targetUrl],
    ['summary', audit.summary ?? report.summary.summary],
    ['performance', String(report.lighthouse.scores.performance)],
    ['accessibility', String(report.lighthouse.scores.accessibility)],
    ['bestPractices', String(report.lighthouse.scores.bestPractices)],
    ['seo', String(report.lighthouse.scores.seo)],
    ['lcp', stringifyNumber(report.lighthouse.metrics.lcp)],
    ['cls', stringifyNumber(report.lighthouse.metrics.cls)],
    ['inp', stringifyNumber(report.lighthouse.metrics.inp)],
    ['tbt', stringifyNumber(report.lighthouse.metrics.tbt)],
    ['pagesCrawled', String(report.crawl.pages.length)],
    ['discoveredUrls', String(report.crawl.discoveredUrls.length)],
    ['priorities', report.summary.priorities.map((priority) => priority.title).join(' | ')],
    ['signals', (report.signals ?? []).map((signal) => `${signal.label}:${signal.status}`).join(' | ')],
  ]

  return rows
    .map((row) => row.map(escapeCsvValue).join(','))
    .join('\n')
}

function stringifyNumber(value: number | null) {
  return value === null ? '' : String(value)
}

function escapeCsvValue(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}
