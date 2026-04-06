import { describe, expect, it, vi } from 'vitest'

import { createAuditSite, createMockAuditReport, type CrawlResult, type LighthouseAudit } from './audit-engine'

describe('createAuditSite', () => {
  it('threads crawl and lighthouse results into a final report', async () => {
    const crawl: CrawlResult = {
      startUrl: 'https://example.com/',
      sitemapUrls: ['https://example.com/sitemap.xml'],
      discoveredUrls: ['https://example.com/about'],
      pages: [
        {
          url: 'https://example.com/',
          title: 'Home',
          status: 200,
          links: ['https://example.com/about'],
        },
      ],
    }

    const lighthouseAudit: LighthouseAudit = {
      url: 'https://example.com/',
      scores: {
        performance: 72,
        accessibility: 88,
        bestPractices: 91,
        seo: 79,
      },
      metrics: {
        lcp: 2400,
        cls: 0,
        inp: 170,
        tbt: 120,
      },
      opportunities: ['Reduce unused JavaScript'],
    }

    const crawlSite = vi.fn(async () => crawl)
    const runLighthouseAudit = vi.fn(async () => lighthouseAudit)
    const summarizeAudit = vi.fn(async () => ({
      source: 'heuristic' as const,
      headline: 'Performance is the weakest area',
      summary: 'Crawled 1 page and found a clear performance gap.',
      priorities: [
        {
          title: 'Improve performance',
          impact: 'Faster first load',
          reason: 'Performance score is below target.',
        },
      ],
    }))

    const auditSite = createAuditSite({
      crawlSite,
      runLighthouseAudit,
      summarizeAudit,
    })

    const report = await auditSite('https://example.com')

    expect(crawlSite).toHaveBeenCalledTimes(1)
    expect(crawlSite).toHaveBeenCalledWith('https://example.com/', {})
    expect(runLighthouseAudit).toHaveBeenCalledTimes(1)
    expect(runLighthouseAudit).toHaveBeenCalledWith('https://example.com/', {})
    expect(summarizeAudit).toHaveBeenCalledTimes(1)
    expect(report.targetUrl).toBe('https://example.com/')
    expect(report.crawl.pages[0]?.title).toBe('Home')
    expect(report.lighthouse.scores.performance).toBe(72)
    expect(report.summary.source).toBe('heuristic')
    expect(report.summary.priorities[0]?.title).toBe('Improve performance')
    expect(report.signals).toHaveLength(20)
    expect(report.signals?.[0]?.label).toBe('GPTBot access')
  })

  it('creates a deterministic mock report for e2e mode', () => {
    const report = createMockAuditReport('https://example.com/audit-target?run=123')

    expect(report.targetUrl).toBe('https://example.com/audit-target?run=123')
    expect(report.crawl.pages).toHaveLength(1)
    expect(report.lighthouse.scores.performance).toBeGreaterThan(0)
    expect(report.summary.priorities.length).toBeGreaterThan(0)
    expect(report.signals).toHaveLength(20)
    expect(report.signals?.every((signal) => signal.status === 'pass' || signal.status === 'warn')).toBe(true)
    expect(report.signals?.map((signal) => signal.label)).toEqual(
      expect.arrayContaining([
        'GPTBot access',
        'Viewport meta',
        'Page title',
        'Meta description',
        'Duplicate titles',
        'Duplicate descriptions',
        'Sitemap coverage',
        'Open Graph title',
        'Open Graph description',
        'Twitter card',
        'JSON-LD schema',
        'hreflang links',
        'Canonical URL',
        'H1 heading',
        'Heading structure',
        'Image alt text',
        'Indexability',
        'Orphan candidates',
        'Redirects',
        'Broken URLs',
      ]),
    )
  })
})
