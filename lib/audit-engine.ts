import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface AuditOptions {
  maxPages?: number
  crawlTimeoutMs?: number
  lighthouseTimeoutMs?: number
  aiModel?: string
  openAiApiKey?: string
}

export interface CrawledPage {
  url: string
  title: string
  status: number
  links: string[]
  facts?: PageFacts
}

export interface CrawlResult {
  startUrl: string
  sitemapUrls: string[]
  discoveredUrls: string[]
  failedUrls?: string[]
  redirectedUrls?: Array<{
    from: string
    to: string
  }>
  pages: CrawledPage[]
  robotsTxt?: string | null
}

export interface LighthouseScores {
  performance: number
  accessibility: number
  bestPractices: number
  seo: number
}

export interface LighthouseMetrics {
  lcp: number | null
  cls: number | null
  inp: number | null
  tbt: number | null
}

export interface LighthouseAudit {
  url: string
  scores: LighthouseScores
  metrics: LighthouseMetrics
  opportunities: string[]
}

export interface AuditPriority {
  title: string
  impact: string
  reason: string
}

export type AuditSignalStatus = 'pass' | 'warn' | 'fail'

export interface AuditSignal {
  key: string
  label: string
  status: AuditSignalStatus
  detail: string
}

interface PageFacts {
  hasViewportMeta: boolean
  jsonLdCount: number
  hreflangCount: number
  canonicalHref: string | null
  metaDescription: string | null
  openGraphTitle: string | null
  openGraphDescription: string | null
  twitterCard: string | null
  h1Count: number
  headingLevels: number[]
  imageCount: number
  missingAltCount: number
  noindex: boolean
}

export interface AuditSummary {
  source: 'heuristic' | 'openai'
  headline: string
  summary: string
  priorities: AuditPriority[]
}

export interface AuditReport {
  targetUrl: string
  crawl: CrawlResult
  lighthouse: LighthouseAudit
  summary: AuditSummary
  signals?: AuditSignal[]
  generatedAt: string
}

export interface AuditDependencies {
  crawlSite: typeof crawlSite
  runLighthouseAudit: typeof runLighthouseAudit
  summarizeAudit: typeof summarizeAudit
}

let lighthouseLoader: Promise<typeof import('lighthouse')> | null = null
let playwrightLoader: Promise<typeof import('@playwright/test')> | null = null

export function createAuditSite(dependencies: Partial<AuditDependencies> = {}) {
  const resolved: AuditDependencies = {
    crawlSite,
    runLighthouseAudit,
    summarizeAudit,
    ...dependencies,
  }

  return async function auditSite(url: string, options: AuditOptions = {}): Promise<AuditReport> {
    const targetUrl = normalizeTargetUrl(url)
    const crawl = await resolved.crawlSite(targetUrl.href, options)
    const lighthouseResult = await resolved.runLighthouseAudit(targetUrl.href, options)
    const signals = buildAuditSignals(crawl)
    const summary = await resolved.summarizeAudit(
      {
        targetUrl: targetUrl.href,
        crawl,
        lighthouse: lighthouseResult,
      },
      options,
    )

    return {
      targetUrl: targetUrl.href,
      crawl,
      lighthouse: lighthouseResult,
      summary,
      signals,
      generatedAt: new Date().toISOString(),
    }
  }
}

export const auditSite = createAuditSite()

export function createMockAuditReport(url: string): AuditReport {
  const targetUrl = normalizeTargetUrl(url)
  const seed = hashString(targetUrl.href)
  const hostLabel = targetUrl.hostname.replace(/^www\./, '')
  const scores = {
    performance: 68 + (seed % 15),
    accessibility: 82 + (seed % 11),
    bestPractices: 84 + (seed % 9),
    seo: 76 + (seed % 13),
  }

  const crawl: CrawlResult = {
    startUrl: targetUrl.href,
    sitemapUrls: [`${targetUrl.origin}/sitemap.xml`],
    discoveredUrls: [`${targetUrl.origin}/about`],
    failedUrls: [],
    redirectedUrls: [],
    robotsTxt: ['User-agent: *', 'Allow: /', '', 'User-agent: GPTBot', 'Allow: /'].join('\n'),
    pages: [
      {
        url: targetUrl.href,
        title: `${hostLabel} landing page for technical SEO review`,
        status: 200,
        links: [`${targetUrl.origin}/about`],
        facts: {
          hasViewportMeta: true,
          metaDescription: `Audit-ready landing page for ${hostLabel} with concise metadata and technical SEO defaults.`,
          openGraphTitle: `${hostLabel} technical SEO audit`,
          openGraphDescription: `Audit-ready landing page for ${hostLabel} with concise metadata and technical SEO defaults.`,
          twitterCard: 'summary_large_image',
          jsonLdCount: 1,
          hreflangCount: 1,
          canonicalHref: targetUrl.href,
          h1Count: 1,
          headingLevels: [1, 2],
          imageCount: 2,
          missingAltCount: 0,
          noindex: false,
        },
      },
    ],
  }

  const lighthouse: LighthouseAudit = {
    url: targetUrl.href,
    scores,
    metrics: {
      lcp: 1800 + (seed % 700),
      cls: Number(((seed % 10) / 100).toFixed(2)),
      inp: 120 + (seed % 90),
      tbt: 80 + (seed % 160),
    },
    opportunities: [
      'Reduce unused JavaScript',
      'Serve images in next-gen formats',
      'Minimize main-thread work',
    ].slice(0, 2 + (seed % 2)),
  }

  return {
    targetUrl: targetUrl.href,
    crawl,
    lighthouse,
    summary: {
      source: 'heuristic',
      headline: getWeakestAreaHeadline(scores),
      summary: `Mock audit for ${targetUrl.href} completed with performance ${scores.performance}, accessibility ${scores.accessibility}, best practices ${scores.bestPractices}, and SEO ${scores.seo}.`,
      priorities: buildMockPriorities(scores, lighthouse.opportunities),
    },
    signals: buildAuditSignals(crawl),
    generatedAt: new Date().toISOString(),
  }
}

export async function crawlSite(url: string, options: AuditOptions = {}): Promise<CrawlResult> {
  const targetUrl = normalizeTargetUrl(url)
  const maxPages = clampInt(options.maxPages, 1, 25, 10)
  const timeoutMs = clampInt(options.crawlTimeoutMs, 1000, 60_000, 10_000)
  const queue: string[] = [targetUrl.href]
  const seen = new Set<string>()
  const discovered = new Set<string>()
  const failedUrls: string[] = []
  const redirectedUrls: CrawlResult['redirectedUrls'] = []
  const pages: CrawledPage[] = []
  const { sitemapUrls, pageUrls, robotsTxt } = await collectSitemapUrls(targetUrl, timeoutMs)

  for (const pageUrl of pageUrls) {
    queue.push(pageUrl)
  }

  while (queue.length > 0 && pages.length < maxPages) {
    const currentUrl = queue.shift()

    if (!currentUrl || seen.has(currentUrl)) {
      continue
    }

    seen.add(currentUrl)

    const response = await fetchText(currentUrl, timeoutMs)
    if (!response.ok || !response.body) {
      failedUrls.push(currentUrl)
      continue
    }

    const finalUrl = response.finalUrl ?? currentUrl
    if (finalUrl !== currentUrl) {
      redirectedUrls.push({
        from: currentUrl,
        to: finalUrl,
      })
    }

    const page = parseHtmlPage(finalUrl, response.body, response.status)
    pages.push(page)

    for (const link of page.links) {
      if (!discovered.has(link)) {
        discovered.add(link)
      }

      if (!seen.has(link) && pages.length + queue.length < maxPages) {
        queue.push(link)
      }
    }
  }

  return {
    startUrl: targetUrl.href,
    sitemapUrls,
    discoveredUrls: Array.from(discovered),
    failedUrls,
    redirectedUrls,
    pages,
    robotsTxt,
  }
}

export async function runLighthouseAudit(url: string, options: AuditOptions = {}): Promise<LighthouseAudit> {
  const targetUrl = normalizeTargetUrl(url)
  const timeoutMs = clampInt(options.lighthouseTimeoutMs, 10_000, 180_000, 60_000)
  const browser = await launchChromeForLighthouse()
  const lighthouse = await loadLighthouse()

  try {
    const result = await Promise.race([
      lighthouse(targetUrl.href, {
        port: browser.port,
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      }),
      timeoutPromise(timeoutMs, 'Lighthouse run timed out'),
    ])

    if (!result) {
      throw new Error('Lighthouse did not return a result')
    }

    const lhr = result.lhr
    const categories = lhr.categories
    const audits = lhr.audits

    return {
      url: targetUrl.href,
      scores: {
        performance: scoreToPercent(categories.performance?.score),
        accessibility: scoreToPercent(categories.accessibility?.score),
        bestPractices: scoreToPercent(categories['best-practices']?.score),
        seo: scoreToPercent(categories.seo?.score),
      },
      metrics: {
        lcp: metricValue(audits['largest-contentful-paint']),
        cls: metricValue(audits['cumulative-layout-shift']),
        inp: metricValue(audits['interaction-to-next-paint']),
        tbt: metricValue(audits['total-blocking-time']),
      },
      opportunities: buildOpportunityList(lhr),
    }
  } finally {
    await browser.close()
  }
}

export async function summarizeAudit(
  input: {
    targetUrl: string
    crawl: CrawlResult
    lighthouse: LighthouseAudit
  },
  options: AuditOptions = {},
): Promise<AuditSummary> {
  const apiKey = options.openAiApiKey ?? process.env.OPENAI_API_KEY
  if (apiKey) {
    const model = options.aiModel ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
    const summary = await summarizeWithOpenAI(input, apiKey, model).catch(() => null)
    if (summary) {
      return summary
    }
  }

  return summarizeHeuristically(input)
}

function normalizeTargetUrl(url: string): URL {
  let targetUrl: URL

  try {
    targetUrl = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${targetUrl.protocol}`)
  }

  return targetUrl
}

async function loadLighthouse() {
  lighthouseLoader ??= import(/* webpackIgnore: true */ 'lighthouse')
  const lighthouseModule = await lighthouseLoader
  return lighthouseModule.default
}

async function loadPlaywright() {
  playwrightLoader ??= import(/* webpackIgnore: true */ '@playwright/test')
  return await playwrightLoader
}

async function collectSitemapUrls(targetUrl: URL, timeoutMs: number): Promise<{ sitemapUrls: string[]; pageUrls: string[]; robotsTxt: string | null }> {
  const sitemapCandidates = [
    new URL('/sitemap.xml', targetUrl).href,
    new URL('/sitemap_index.xml', targetUrl).href,
  ]

  const robotsUrl = new URL('/robots.txt', targetUrl).href
  const robotsResponse = await fetchText(robotsUrl, timeoutMs)
  const robotsTxt = robotsResponse.ok && robotsResponse.body ? robotsResponse.body : null

  if (robotsTxt) {
    for (const line of robotsTxt.split(/\r?\n/)) {
      const match = /^sitemap:\s*(.+)$/i.exec(line.trim())
      if (match) {
        sitemapCandidates.push(match[1].trim())
      }
    }
  }

  const sitemapUrls = new Set<string>()
  const pageUrls = new Set<string>()
  const sitemapQueue = [...sitemapCandidates]

  while (sitemapQueue.length > 0) {
    const candidate = sitemapQueue.shift()
    if (!candidate || sitemapUrls.has(candidate)) {
      continue
    }

    const sitemapResponse = await fetchText(candidate, timeoutMs)
    if (!sitemapResponse.ok || !sitemapResponse.body) {
      continue
    }

    sitemapUrls.add(candidate)

    for (const loc of sitemapResponse.body.match(/<loc>(.*?)<\/loc>/gi) ?? []) {
      const value = loc.replace(/<\/?loc>/gi, '').trim()
      const resolved = toSameOriginUrl(value, targetUrl)
      if (!resolved) {
        continue
      }

      if (resolved.pathname.endsWith('.xml')) {
        sitemapQueue.push(resolved.href)
      } else {
        pageUrls.add(resolved.href)
      }
    }
  }

  return {
    sitemapUrls: Array.from(sitemapUrls),
    pageUrls: Array.from(pageUrls),
    robotsTxt,
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: string | null; finalUrl: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Tec SEO Auditor',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
      finalUrl: response.url,
    }
  } catch {
    return {
      ok: false,
      status: 0,
      body: null,
      finalUrl: null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseHtmlPage(url: string, html: string, status: number): CrawledPage {
  const links = extractLinks(html, url)
  return {
    url,
        title: extractTitle(html),
        status,
        links,
        facts: extractPageFacts(html),
      }
}

function extractPageFacts(html: string): PageFacts {
  return {
    hasViewportMeta: /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(html),
    jsonLdCount: countMatches(html, /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/gi),
    hreflangCount: countMatches(html, /<link\b[^>]*rel\s*=\s*["'][^"']*alternate[^"']*["'][^>]*hreflang\s*=\s*["'][^"']+["'][^>]*>/gi),
    canonicalHref: extractCanonicalHref(html),
    metaDescription: extractMetaDescription(html),
    openGraphTitle: extractMetaContent(html, 'property', 'og:title'),
    openGraphDescription: extractMetaContent(html, 'property', 'og:description'),
    twitterCard: extractMetaContent(html, 'name', 'twitter:card'),
    h1Count: countMatches(html, /<h1\b[^>]*>/gi),
    headingLevels: extractHeadingLevels(html),
    imageCount: countMatches(html, /<img\b[^>]*>/gi),
    missingAltCount: countMissingAltImages(html),
    noindex: /<meta\b[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*noindex[^"']*["'][^>]*>/i.test(html),
  }
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? stripTags(match[1]).trim() : ''
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>()
  const regex = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi

  for (const match of html.matchAll(regex)) {
    const href = match[1]?.trim()
    if (!href) {
      continue
    }

    const resolved = toSameOriginUrl(href, new URL(baseUrl))
    if (resolved) {
      links.add(resolved.href)
    }
  }

  return Array.from(links)
}

function toSameOriginUrl(value: string, baseUrl: URL): URL | null {
  if (!value || value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:')) {
    return null
  }

  try {
    const resolved = new URL(value, baseUrl)
    if (resolved.origin !== baseUrl.origin) {
      return null
    }

    resolved.hash = ''
    return resolved
  } catch {
    return null
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ')
}

function extractCanonicalHref(html: string): string | null {
  const match = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i.exec(html)
  return match?.[1]?.trim() ?? null
}

function extractMetaDescription(html: string): string | null {
  const match = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i.exec(html)
  return match?.[1]?.trim() ?? null
}

function extractMetaContent(html: string, attribute: 'name' | 'property', value: string): string | null {
  const pattern = new RegExp(
    `<meta\\b[^>]*${attribute}\\s*=\\s*["']${escapeRegExp(value)}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
    'i',
  )
  const match = pattern.exec(html)
  return match?.[1]?.trim() ?? null
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length
}

function extractHeadingLevels(html: string): number[] {
  const levels: number[] = []
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>/gi)) {
    const level = Number(match[1])
    if (!Number.isNaN(level)) {
      levels.push(level)
    }
  }

  return levels
}

function countMissingAltImages(html: string): number {
  let missing = 0

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0] ?? ''
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const alt = altMatch?.[1] ?? altMatch?.[2] ?? null

    if (alt === null || alt.trim() === '') {
      missing += 1
    }
  }

  return missing
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreToPercent(score: number | null | undefined): number {
  if (typeof score !== 'number') {
    return 0
  }

  return Math.round(score * 100)
}

function hashString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

function getWeakestAreaHeadline(scores: LighthouseScores): string {
  const ordered = Object.entries(scores).sort((left, right) => left[1] - right[1])
  const weakest = ordered[0]?.[0]

  if (!weakest) {
    return 'Audit completed with no Lighthouse data'
  }

  return `${weakest} is the weakest area`
}

function buildMockPriorities(scores: LighthouseScores, opportunities: string[]): AuditPriority[] {
  const priorities: AuditPriority[] = []

  if (scores.performance < 90) {
    priorities.push({
      title: 'Improve performance',
      impact: 'Faster first load',
      reason: 'Performance is below the target threshold in the mock audit.',
    })
  }

  if (scores.accessibility < 90) {
    priorities.push({
      title: 'Improve accessibility',
      impact: 'Better keyboard and screen reader support',
      reason: 'Accessibility still has room to improve in the mock audit.',
    })
  }

  if (scores.seo < 90) {
    priorities.push({
      title: 'Improve SEO signals',
      impact: 'Clearer indexing and richer snippets',
      reason: 'SEO scoring indicates there is still meaningful headroom.',
    })
  }

  if (opportunities.length > 0 && priorities.length < 4) {
    priorities.push({
      title: 'Address Lighthouse opportunities',
      impact: 'Reduce audit friction',
      reason: opportunities.slice(0, 3).join(', '),
    })
  }

  return priorities.slice(0, 4)
}

function metricValue(audit: { numericValue?: number | null } | undefined): number | null {
  if (!audit || typeof audit.numericValue !== 'number' || Number.isNaN(audit.numericValue)) {
    return null
  }

  return Math.round(audit.numericValue)
}

function buildOpportunityList(result: { audits: Record<string, { title?: string; scoreDisplayMode?: string; score?: number | null }> }): string[] {
  return Object.values(result.audits)
    .filter((audit) => audit.scoreDisplayMode === 'numeric' || audit.scoreDisplayMode === 'binary')
    .filter((audit) => typeof audit.score === 'number' && audit.score < 1)
    .map((audit) => audit.title?.trim())
    .filter((title): title is string => Boolean(title))
    .slice(0, 5)
}

async function summarizeWithOpenAI(
  input: {
    targetUrl: string
    crawl: CrawlResult
    lighthouse: LighthouseAudit
  },
  apiKey: string,
  model: string,
): Promise<AuditSummary | null> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a technical SEO auditor. Return only valid JSON with keys headline, summary, and priorities. priorities must be an array of objects with title, impact, and reason.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              targetUrl: input.targetUrl,
              pagesCrawled: input.crawl.pages.length,
              sitemapUrls: input.crawl.sitemapUrls.length,
              lighthouseScores: input.lighthouse.scores,
              lighthouseMetrics: input.lighthouse.metrics,
              opportunities: input.lighthouse.opportunities,
              pageTitles: input.crawl.pages.slice(0, 5).map((page) => page.title),
            },
            null,
            2,
          ),
        },
      ],
    }),
  })

  if (!response.ok) {
    return null
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
      }
    }>
  }

  const raw = payload.choices?.[0]?.message?.content?.trim()
  if (!raw) {
    return null
  }

  const parsed = safeJsonParse<Partial<AuditSummary>>(raw)
  if (!parsed || typeof parsed.headline !== 'string' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.priorities)) {
    return null
  }

  return {
    source: 'openai',
    headline: parsed.headline,
    summary: parsed.summary,
    priorities: parsed.priorities
      .map((priority) => ({
        title: typeof priority?.title === 'string' ? priority.title : '',
        impact: typeof priority?.impact === 'string' ? priority.impact : '',
        reason: typeof priority?.reason === 'string' ? priority.reason : '',
      }))
      .filter((priority) => priority.title && priority.impact && priority.reason),
  }
}

function summarizeHeuristically(input: {
  targetUrl: string
  crawl: CrawlResult
  lighthouse: LighthouseAudit
}): AuditSummary {
  const pages = input.crawl.pages.length
  const discovered = input.crawl.discoveredUrls.length
  const scores = input.lighthouse.scores
  const orderedScores = Object.entries(scores).sort((left, right) => left[1] - right[1])
  const weakestScore = orderedScores[0]
  const headline = weakestScore
    ? `${weakestScore[0]} is the weakest area`
    : 'Audit completed with no Lighthouse data'
  const summary = `Crawled ${pages} page${pages === 1 ? '' : 's'} and discovered ${discovered} internal URL${discovered === 1 ? '' : 's'}. Lighthouse scores are performance ${scores.performance}, accessibility ${scores.accessibility}, best practices ${scores.bestPractices}, and SEO ${scores.seo}.`

  const priorities: AuditPriority[] = []
  if (scores.performance < 90) {
    priorities.push({
      title: 'Improve performance',
      impact: 'Higher perceived speed and better Core Web Vitals',
      reason: 'Lighthouse performance is below the ideal threshold.',
    })
  }

  if (scores.seo < 90) {
    priorities.push({
      title: 'Tighten on-page SEO',
      impact: 'Better crawlability and indexation',
      reason: 'The SEO score suggests metadata or structural gaps.',
    })
  }

  if (scores.accessibility < 90) {
    priorities.push({
      title: 'Fix accessibility issues',
      impact: 'Improved usability and fewer automated audit failures',
      reason: 'Accessibility checks still have room to improve.',
    })
  }

  if (input.lighthouse.opportunities.length > 0 && priorities.length < 4) {
    priorities.push({
      title: 'Address Lighthouse opportunities',
      impact: 'Reduce avoidable regressions',
      reason: input.lighthouse.opportunities.slice(0, 3).join(', '),
    })
  }

  if (priorities.length === 0) {
    priorities.push({
      title: 'Expand crawl coverage',
      impact: 'Broader page discovery for the next audit pass',
      reason: 'The crawl completed cleanly, so the next gain is more coverage.',
    })
  }

  return {
    source: 'heuristic',
    headline,
    summary,
    priorities: priorities.slice(0, 4),
  }
}

function buildAuditSignals(crawl: CrawlResult): AuditSignal[] {
  const rootPage = crawl.pages[0]
  const facts = rootPage?.facts
  const orphanCandidates = Math.max(0, crawl.discoveredUrls.length - crawl.pages.length)
  const robotsStatus = inspectGptBotAccess(crawl.robotsTxt)
  const titleLength = rootPage?.title.trim().length ?? 0
  const metaDescriptionLength = facts?.metaDescription?.trim().length ?? 0
  const canonicalStatus = inspectCanonicalHref(rootPage?.url ?? null, facts?.canonicalHref ?? null)
  const h1Count = facts?.h1Count ?? 0
  const sitemapCount = crawl.sitemapUrls.length
  const failedUrlCount = crawl.failedUrls?.length ?? 0
  const titleDuplicateCount = countDuplicateValues(crawl.pages.map((page) => page.title.trim()).filter(Boolean))
  const metaDescriptionDuplicateCount = countDuplicateValues(
    crawl.pages.map((page) => page.facts?.metaDescription?.trim() ?? '').filter(Boolean),
  )
  const headingStatus = inspectHeadingHierarchy(facts?.headingLevels ?? [])
  const altStatus = inspectImageAltCoverage(facts?.imageCount ?? 0, facts?.missingAltCount ?? 0)
  const openGraphTitleStatus = inspectPresence(
    facts?.openGraphTitle,
    'Open Graph title',
    'No Open Graph title was found on the first crawled page.',
  )
  const openGraphDescriptionStatus = inspectPresence(
    facts?.openGraphDescription,
    'Open Graph description',
    'No Open Graph description was found on the first crawled page.',
  )
  const twitterCardStatus = inspectPresence(
    facts?.twitterCard,
    'Twitter card',
    'No Twitter card metadata was found on the first crawled page.',
  )

  return [
    {
      key: 'robots-gptbot',
      label: 'GPTBot access',
      status: robotsStatus.status,
      detail: robotsStatus.detail,
    },
    {
      key: 'sitemap-coverage',
      label: 'Sitemap coverage',
      status: sitemapCount > 0 ? 'pass' : 'warn',
      detail:
        sitemapCount > 0
          ? `The crawl found ${sitemapCount} sitemap URL(s).`
          : 'No sitemap URLs were discovered during the crawl.',
    },
    {
      key: 'viewport-meta',
      label: 'Viewport meta',
      status: facts?.hasViewportMeta ? 'pass' : 'warn',
      detail: facts?.hasViewportMeta
        ? 'The landing page includes a responsive viewport tag.'
        : 'No viewport meta tag was found on the first crawled page.',
    },
    {
      key: 'page-title',
      label: 'Page title',
      status: titleLength >= 30 && titleLength <= 60 ? 'pass' : 'warn',
      detail:
        titleLength >= 30 && titleLength <= 60
          ? `The first crawled page title is ${titleLength} characters long.`
          : titleLength === 0
            ? 'No page title was detected on the first crawled page.'
            : `The first crawled page title is ${titleLength} characters long, which is outside the preferred range.`,
    },
    {
      key: 'meta-description',
      label: 'Meta description',
      status: metaDescriptionLength >= 50 && metaDescriptionLength <= 160 ? 'pass' : 'warn',
      detail:
        metaDescriptionLength >= 50 && metaDescriptionLength <= 160
          ? `The first crawled page has a ${metaDescriptionLength}-character meta description.`
          : facts?.metaDescription
            ? `The first crawled page meta description is ${metaDescriptionLength} characters long and should be reviewed.`
            : 'No meta description was found on the first crawled page.',
    },
    {
      key: 'duplicate-titles',
      label: 'Duplicate titles',
      status: titleDuplicateCount === 0 ? 'pass' : 'warn',
      detail:
        titleDuplicateCount === 0
          ? 'No duplicate page titles were found in the current crawl.'
          : `${titleDuplicateCount} duplicate page title group(s) were found across crawled pages.`,
    },
    {
      key: 'duplicate-descriptions',
      label: 'Duplicate descriptions',
      status: metaDescriptionDuplicateCount === 0 ? 'pass' : 'warn',
      detail:
        metaDescriptionDuplicateCount === 0
          ? 'No duplicate meta descriptions were found in the current crawl.'
          : `${metaDescriptionDuplicateCount} duplicate meta description group(s) were found across crawled pages.`,
    },
    {
      key: 'open-graph-title',
      label: 'Open Graph title',
      status: openGraphTitleStatus.status,
      detail: openGraphTitleStatus.detail,
    },
    {
      key: 'open-graph-description',
      label: 'Open Graph description',
      status: openGraphDescriptionStatus.status,
      detail: openGraphDescriptionStatus.detail,
    },
    {
      key: 'twitter-card',
      label: 'Twitter card',
      status: twitterCardStatus.status,
      detail: twitterCardStatus.detail,
    },
    {
      key: 'json-ld',
      label: 'JSON-LD schema',
      status: (facts?.jsonLdCount ?? 0) > 0 ? 'pass' : 'warn',
      detail:
        (facts?.jsonLdCount ?? 0) > 0
          ? `${facts?.jsonLdCount ?? 0} structured data block(s) found on the first crawled page.`
          : 'No JSON-LD blocks were detected on the first crawled page.',
    },
    {
      key: 'hreflang',
      label: 'hreflang links',
      status: (facts?.hreflangCount ?? 0) > 0 ? 'pass' : 'warn',
      detail:
        (facts?.hreflangCount ?? 0) > 0
          ? `${facts?.hreflangCount ?? 0} hreflang link(s) were found on the first crawled page.`
          : 'No hreflang links were found on the first crawled page.',
    },
    {
      key: 'canonical-url',
      label: 'Canonical URL',
      status: canonicalStatus.status,
      detail: canonicalStatus.detail,
    },
    {
      key: 'h1-heading',
      label: 'H1 heading',
      status: h1Count === 1 ? 'pass' : h1Count === 0 ? 'fail' : 'warn',
      detail:
        h1Count === 1
          ? 'The first crawled page has a single H1 heading.'
          : h1Count === 0
            ? 'No H1 heading was found on the first crawled page.'
            : `The first crawled page has ${h1Count} H1 headings.`,
    },
    {
      key: 'heading-structure',
      label: 'Heading structure',
      status: headingStatus.status,
      detail: headingStatus.detail,
    },
    {
      key: 'image-alt',
      label: 'Image alt text',
      status: altStatus.status,
      detail: altStatus.detail,
    },
    {
      key: 'noindex',
      label: 'Indexability',
      status: facts?.noindex ? 'fail' : 'pass',
      detail: facts?.noindex
        ? 'The first crawled page contains a noindex directive.'
        : 'The first crawled page does not contain a noindex directive.',
    },
    {
      key: 'orphan-candidates',
      label: 'Orphan candidates',
      status: orphanCandidates === 0 ? 'pass' : 'warn',
      detail:
        orphanCandidates === 0
          ? 'All discovered URLs were covered by the current crawl pass.'
          : `${orphanCandidates} discovered URL(s) were not crawled in this pass and should be reviewed.`,
    },
    {
      key: 'redirects',
      label: 'Redirects',
      status: (crawl.redirectedUrls?.length ?? 0) === 0 ? 'pass' : 'warn',
      detail:
        (crawl.redirectedUrls?.length ?? 0) === 0
          ? 'No redirects were encountered during the crawl.'
          : `${crawl.redirectedUrls?.length ?? 0} URL(s) redirected during the crawl.`,
    },
    {
      key: 'broken-urls',
      label: 'Broken URLs',
      status: failedUrlCount === 0 ? 'pass' : 'fail',
      detail:
        failedUrlCount === 0
          ? 'No failed fetches were encountered during the crawl.'
          : `${failedUrlCount} URL(s) failed to load during the crawl.`,
    },
  ]
}

function countDuplicateValues(values: string[]): number {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return Array.from(counts.values()).filter((count) => count > 1).length
}

function inspectPresence(
  value: string | null | undefined,
  label: string,
  missingDetail: string,
): { status: AuditSignalStatus; detail: string } {
  if (!value || !value.trim()) {
    return {
      status: 'warn',
      detail: missingDetail,
    }
  }

  return {
    status: 'pass',
    detail: `${label} was found on the first crawled page.`,
  }
}

function inspectHeadingHierarchy(levels: number[]): { status: AuditSignalStatus; detail: string } {
  if (levels.length === 0) {
    return {
      status: 'warn',
      detail: 'No headings were detected on the first crawled page.',
    }
  }

  if (levels[0] !== 1) {
    return {
      status: 'warn',
      detail: `The first heading on the page is H${levels[0]}, not H1.`,
    }
  }

  for (let index = 1; index < levels.length; index += 1) {
    if (levels[index] - levels[index - 1] > 1) {
      return {
        status: 'warn',
        detail: `The heading structure skips from H${levels[index - 1]} to H${levels[index]}.`,
      }
    }
  }

  return {
    status: 'pass',
    detail: `The page uses a sensible heading structure across ${levels.length} headings.`,
  }
}

function inspectImageAltCoverage(imageCount: number, missingAltCount: number): { status: AuditSignalStatus; detail: string } {
  if (imageCount === 0) {
    return {
      status: 'pass',
      detail: 'No images were found on the first crawled page.',
    }
  }

  if (missingAltCount === 0) {
    return {
      status: 'pass',
      detail: `All ${imageCount} image(s) on the first crawled page have alt text.`,
    }
  }

  return {
    status: 'warn',
    detail: `${missingAltCount} of ${imageCount} image(s) on the first crawled page are missing alt text.`,
  }
}

function inspectCanonicalHref(targetUrl: string | null, canonicalHref: string | null): { status: AuditSignalStatus; detail: string } {
  if (!targetUrl) {
    return {
      status: 'warn',
      detail: 'The canonical URL could not be evaluated because no crawled page was available.',
    }
  }

  if (!canonicalHref) {
    return {
      status: 'warn',
      detail: 'No canonical link element was found on the first crawled page.',
    }
  }

  try {
    const resolvedCanonical = new URL(canonicalHref, targetUrl).href
    const normalizedTarget = new URL(targetUrl).href

    if (resolvedCanonical === normalizedTarget) {
      return {
        status: 'pass',
        detail: `The canonical URL matches the crawled page: ${resolvedCanonical}.`,
      }
    }

    return {
      status: 'warn',
      detail: `The canonical URL resolves to ${resolvedCanonical}, which does not match the crawled page ${normalizedTarget}.`,
    }
  } catch {
    return {
      status: 'warn',
      detail: `The canonical URL "${canonicalHref}" could not be resolved against the crawled page.`,
    }
  }
}

function inspectGptBotAccess(robotsTxt: string | null | undefined): { status: AuditSignalStatus; detail: string } {
  if (!robotsTxt) {
    return {
      status: 'warn',
      detail: 'No robots.txt file was found, so GPTBot access could not be confirmed.',
    }
  }

  const lines = robotsTxt.split(/\r?\n/)
  let currentAgents: string[] = []
  let gptBotDecision: 'allow' | 'disallow' | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      currentAgents = []
      continue
    }

    const userAgentMatch = /^user-agent:\s*(.+)$/i.exec(line)
    if (userAgentMatch) {
      currentAgents.push(userAgentMatch[1].trim().toLowerCase())
      continue
    }

    const ruleMatch = /^(allow|disallow):\s*(.*)$/i.exec(line)
    if (!ruleMatch) {
      continue
    }

    if (!currentAgents.includes('gptbot')) {
      continue
    }

    const rule = ruleMatch[1].toLowerCase()
    const value = ruleMatch[2].trim()

    if (value === '/') {
      gptBotDecision = rule === 'allow' ? 'allow' : 'disallow'
    }
  }

  if (gptBotDecision === 'allow') {
    return {
      status: 'pass',
      detail: 'robots.txt explicitly allows GPTBot access.',
    }
  }

  if (gptBotDecision === 'disallow') {
    return {
      status: 'warn',
      detail: 'robots.txt explicitly blocks GPTBot access.',
    }
  }

  const hasGptBotGroup = /user-agent:\s*gptbot/i.test(robotsTxt)
  return {
    status: hasGptBotGroup ? 'warn' : 'warn',
    detail: hasGptBotGroup
      ? 'robots.txt mentions GPTBot, but no explicit allow or disallow rule was detected.'
      : 'robots.txt does not mention GPTBot explicitly.',
  }
}

async function launchChromeForLighthouse(): Promise<{ port: number; close: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tec-seo-auditor-'))
  const { chromium } = await loadPlaywright()
  const executablePath = chromium.executablePath()
  const browser = spawn(
    executablePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      `--user-data-dir=${tempDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )

  const wsEndpoint = await waitForDevToolsEndpoint(browser)
  const { port } = new URL(wsEndpoint)

  return {
    port: Number(port),
    close: async () => {
      browser.kill('SIGKILL')
      await fs.rm(tempDir, { recursive: true, force: true })
    },
  }
}

function waitForDevToolsEndpoint(browser: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for Chromium to expose DevTools'))
    }, 15_000)

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`Chromium exited before DevTools was ready (${code ?? 'null'}, ${signal ?? 'null'})`))
    }

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
      if (match?.[1]) {
        cleanup()
        resolve(match[1])
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      browser.stderr?.off('data', onData)
      browser.off('exit', onExit)
    }

    browser.stderr?.on('data', onData)
    browser.once('exit', onExit)
  })
}

function timeoutPromise(timeoutMs: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), timeoutMs)
  })
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.floor(value)))
}
