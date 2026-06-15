const { test, devices } = require('@playwright/test');

test.use({
  ...devices['iPhone 12'],
});

test('capture mobile screenshot', async ({ page }) => {
  console.log('Navigating to http://localhost:8080/stats.html...');
  await page.goto('http://localhost:8080/stats.html');
  
  // Wait for database loading: check that #stats-summary text changes from "Loading…"
  console.log('Waiting for data to load...');
  await page.waitForFunction(() => {
    const el = document.getElementById('stats-summary');
    return el && el.textContent && !el.textContent.includes('Loading');
  }, { timeout: 20000 });

  // Also wait for the grid to render cards
  await page.waitForSelector('#learned-stats-grid .stats-card', { timeout: 20000 });
  
  // Enter search query "學" (traditional character) to check simplified notation difference and search functionality
  console.log('Searching for "學"...');
  await page.fill('#stats-search-input', '學');
  
  // Allow an extra 1.5 seconds for all layout rendering and transitions to settle
  await page.waitForTimeout(1500);

  // Set viewport to exactly 2x the standard iPhone 12 viewport height (844 * 2 = 1688)
  await page.setViewportSize({ width: 390, height: 1688 });
  
  const screenshotPath = '/Users/steven/.gemini/antigravity/brain/2b19e33d-b02b-4b08-86fd-24ac4db6711d/mobile_stats_screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved to: ${screenshotPath}`);
});
