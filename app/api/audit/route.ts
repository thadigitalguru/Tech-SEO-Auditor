import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { evaluateAuditScoreAlerts } from '@/lib/alert-engine'
import { auditSite, createMockAuditReport } from '@/lib/audit-engine'
import { saveAuditReport } from '@/lib/audit-store'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: unknown }
    const url = typeof body.url === 'string' ? body.url.trim() : ''

    if (!url) {
      return NextResponse.json({ error: 'A URL is required.' }, { status: 400 })
    }

    const report =
      process.env.AUDIT_E2E_MODE === '1'
        ? createMockAuditReport(url)
        : await auditSite(url)
    const { userId } = await auth()
    const audit = await saveAuditReport(report, userId ?? null)
    const alerts = await evaluateAuditScoreAlerts(audit, userId ?? null)

    return NextResponse.json({
      audit: {
        id: audit.id,
        summary: audit.summary,
        createdAt: audit.createdAt,
      },
      report,
      alerts: {
        triggered: alerts.length,
      },
      redirectTo: `/audits/${audit.id}`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to run audit.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
