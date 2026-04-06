import { expect, test } from '@playwright/test'

test.describe('audit flow', () => {
  test.setTimeout(240_000)

  test('submits URLs, compares reports, and revisits history', async ({ page }) => {
    const firstTargetUrl = `http://127.0.0.1:3000/audit-target?run=${Date.now()}-one`
    const secondTargetUrl = `http://127.0.0.1:3000/audit-target?run=${Date.now()}-two`

    await page.goto('/')
    await page.getByRole('textbox', { name: /website url/i }).fill(firstTargetUrl)
    await page.getByRole('button', { name: /run audit/i }).click()

    await page.waitForURL((url) => url.pathname.startsWith('/audits/'))

    await expect(page.getByText(/audit dashboard/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: firstTargetUrl })).toBeVisible()
    await expect(page.getByRole('link', { name: /shareable report link/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /export json/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /export csv/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /export trend json/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /export trend csv/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /open schedule history/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /scheduled re-audits/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /score trends/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /alert trends/i })).toBeVisible()
    await expect(page.getByText(/run another audit to build a score trend/i)).toBeVisible()
    await expect(page.getByText(/save an alert rule and run another audit to see alert history here/i)).toBeVisible()
    await page.getByRole('button', { name: /save schedule/i }).click()
    await expect(page.getByText(/schedule saved/i)).toBeVisible()
    await expect(page.getByText(/^Performance$/)).toBeVisible()
    await expect(page.getByText(/^Accessibility$/)).toBeVisible()
    await expect(page.getByRole('heading', { name: /priorities/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Signals', exact: true })).toBeVisible()

    await page.getByRole('combobox', { name: /drop threshold/i }).selectOption('3')
    await page.getByRole('textbox', { name: /delivery target/i }).fill(
      `http://127.0.0.1:3000/webhook-${Date.now()}`,
    )
    await page.getByRole('button', { name: /save alert|update alert/i }).click()
    await expect(page.getByText(/alert rule saved/i)).toBeVisible()
    await expect(page.getByText(/drops will be recorded on future audits/i)).toBeVisible()
    await page.reload()
    await expect(page.getByText(/alert when any core score drops by 3 or more points/i)).toBeVisible()
    await page.getByRole('link', { name: /open alert history/i }).click()
    await page.waitForURL((url) => url.pathname.includes('/alerts'))
    await expect(page.getByRole('heading', { name: /alert history/i })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /metric/i })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /delivery status/i })).toBeVisible()
    await page.getByRole('link', { name: /back to report/i }).click()
    await page.waitForURL((url) => /^\/audits\/[^/]+$/.test(url.pathname))

    await page.getByRole('link', { name: /open schedule history/i }).click()
    await page.waitForURL((url) => url.pathname.includes('/schedule'))
    await expect(page.getByRole('heading', { name: /run history/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /run now/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /deactivate schedule/i })).toBeVisible()
    await page.getByRole('link', { name: /back to report/i }).click()
    await page.waitForURL((url) => /^\/audits\/[^/]+$/.test(url.pathname))

    const firstDashboardUrl = page.url()
    const jsonExportResponse = await page.request.get(`${firstDashboardUrl}/export`)
    expect(jsonExportResponse.ok()).toBe(true)
    expect(jsonExportResponse.headers()['content-disposition']).toContain('.json')
    expect(await jsonExportResponse.json()).toHaveProperty('results')

    const csvExportResponse = await page.request.get(`${firstDashboardUrl}/export?format=csv`)
    expect(csvExportResponse.ok()).toBe(true)
    expect(csvExportResponse.headers()['content-type']).toContain('text/csv')
    expect(await csvExportResponse.text()).toContain('field,value')

    await page.goto('/')
    await page.getByRole('textbox', { name: /website url/i }).fill(secondTargetUrl)
    await page.getByRole('button', { name: /run audit/i }).click()
    await page.waitForURL((url) => url.pathname.startsWith('/audits/'))
    await expect(page.getByRole('heading', { name: secondTargetUrl })).toBeVisible()

    await page.goto(firstDashboardUrl)
    await page.getByRole('button', { name: /^Compare$/ }).click()
    await page.waitForURL((url) => url.pathname.includes('/compare'))
    await expect(page.getByText(/^Compare reports$/)).toBeVisible()
    await expect(page.getByRole('heading', { name: /score changes/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /metric changes/i })).toBeVisible()

    await page.getByRole('link', { name: /back to report/i }).click()
    await expect(page).toHaveURL(new RegExp(firstDashboardUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    await page.getByRole('link', { name: /back to recent audits/i }).click()
    await expect(page).toHaveURL(/\/audits$/)
    await expect(page.getByRole('heading', { name: /saved reports and history/i })).toBeVisible()
    await expect(page.getByRole('link').filter({ hasText: firstTargetUrl })).toBeVisible()
    await expect(page.getByRole('link').filter({ hasText: secondTargetUrl })).toBeVisible()
  })
})
