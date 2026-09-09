#!/usr/bin/env node
/**
 * Quick browser test for deployed Databricks app.
 * Run: npx playwright test scripts/browser-test.mjs (or use playwright directly)
 * Or: node scripts/browser-test.mjs  (if using playwright as lib)
 */
import { chromium } from 'playwright';

const BASE = process.env.APP_BASE_URL || 'https://realtime-transcription-demo-7474647152304469.aws.databricksapps.com';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['microphone'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  const results = {
    auth: null,
    whisperlive: {},
    blocking: [],
  };

  try {
    // 1) Open URL
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    const title = await page.title();
    const hasSignIn = /sign|login|auth/i.test(url) || /Sign In|Log in/i.test(await page.content());

    results.auth = hasSignIn
      ? 'SIGN_IN_REQUIRED (page shows auth)'
      : 'AUTHENTICATED (or no auth gate)';

    if (hasSignIn) {
      results.blocking.push('Sign-in required; cannot automate OAuth/SSO. Manual login needed.');
    }

    // 2) Navigate to WhisperLive (if we got past auth)
    if (!hasSignIn) {
      await page.goto(`${BASE}/whisperlive`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1000);

      const startBtnWL = page.locator('button:has-text("Start"), button:has-text("start")').first();
      const stopBtnWL = page.locator('button:has-text("Stop"), button:has-text("stop")').first();

      if (await startBtnWL.count() > 0) {
        await startBtnWL.click();
        await page.waitForTimeout(3000);

        const recordingStateWL = await page.locator('[class*="record"], [data-state*="record"]').count();
        const transcriptWL = await page.locator('[class*="transcript"], [class*="segment"]').textContent().catch(() => '');
        const logsWL = await page.locator('[class*="log"]').textContent().catch(() => '');
        const errorsWL = await page.locator('[class*="error"], [role="alert"]').textContent().catch(() => '');

        results.whisperlive = {
          recordingStateChanged: recordingStateWL > 0,
          transcriptUpdates: !!transcriptWL?.trim(),
          logEntries: !!logsWL?.trim(),
          visibleErrors: errorsWL || 'none',
        };

        if (await stopBtnWL.count() > 0) {
          await stopBtnWL.click();
          await page.waitForTimeout(500);
        }
      } else {
        results.whisperlive = { error: 'Start button not found' };
      }
    }
  } catch (e) {
    results.blocking.push(`Test error: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
