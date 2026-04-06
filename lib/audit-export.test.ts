import { describe, expect, it } from 'vitest'

import { formatAuditExportFilename, serializeAuditAsCsv } from './audit-export'
import type { StoredAudit } from './audit-store'

const audit: StoredAudit = {
  id: 'audit_1',
  summary: 'A short summary',
  createdAt: new Date('2026-04-05T12:00:00Z'),
  userId: null,
  results: {
    targetUrl: 'https://example.com/',
    crawl: {
      startUrl: 'https://example.com/',
      sitemapUrls: [],
      discoveredUrls: ['https://example.com/'],
      pages: [],
    },
    lighthouse: {
      url: 'https://example.com/',
      scores: {
        performance: 88,
        accessibility: 94,
        bestPractices: 90,
        seo: 92,
      },
      metrics: {
        lcp: 1700,
        cls: 0.01,
        inp: null,
        tbt: 55,
      },
      opportunities: [],
    },
    summary: {
      source: 'heuristic',
      headline: 'Headline',
      summary: 'A short summary',
      priorities: [],
    },
    signals: [
      {
        key: 'viewport-meta',
        label: 'Viewport meta',
        status: 'pass',
        detail: 'The landing page includes a responsive viewport tag.',
      },
      {
        key: 'twitter-card',
        label: 'Twitter card',
        status: 'pass',
        detail: 'Twitter card metadata was found on the first crawled page.',
      },
    ],
    generatedAt: '2026-04-05T12:00:00Z',
  },
}

describe('audit export helpers', () => {
  it('builds export filenames', () => {
    expect(formatAuditExportFilename(audit, 'json')).toBe('audit-audit_1.json')
    expect(formatAuditExportFilename(audit, 'csv')).toBe('audit-audit_1.csv')
  })

  it('serializes an audit as csv', () => {
    const csv = serializeAuditAsCsv(audit)

    expect(csv).toContain('targetUrl,https://example.com/')
    expect(csv).toContain('performance,88')
    expect(csv).toContain('signals,Viewport meta:pass')
    expect(csv).toContain('Twitter card:pass')
    expect(csv).toContain('inp,')
  })
})
