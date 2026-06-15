const { test, devices } = require('@playwright/test');

test.use({
  ...devices['Desktop Chrome'],
});

test('capture desktop screenshot', async ({ page }) => {
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

  // Set viewport to standard desktop size
  await page.setViewportSize({ width: 1280, height: 900 });
  
  const screenshotPath = '/Users/steven/.gemini/antigravity/brain/2b19e33d-b02b-4b08-86fd-24ac4db6711d/desktop_stats_screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved to: ${screenshotPath}`);
});
