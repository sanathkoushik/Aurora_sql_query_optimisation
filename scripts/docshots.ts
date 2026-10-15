/**
 * Captures the Query Inspector screenshots used in the project report (docs/screenshots/).
 *   npm run dev -- --port 47831 --host 127.0.0.1   (in another terminal)
 *   npx tsx scripts/docshots.ts [http://127.0.0.1:47831/]
 */
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT } from './lib/nodeRuntime';

const url = process.argv[2] ?? 'http://127.0.0.1:47831/';
const out = join(ROOT, 'docs', 'screenshots');
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.goto(url);
await page.waitForSelector('.pill:has-text("Pyodide")', { timeout: 180_000 });
await page.waitForSelector('td:has-text("50,000")', { timeout: 60_000 }); // dataset profile (orders, medium) is listed

const left = page.locator('.layout > div').first();
const right = page.locator('.layout > .card');
const editorCard = page.locator('.layout > div').first().locator('.card').first();

// 1. successful compilation (editor + dataset)
await left.screenshot({ path: join(out, '01-compile-success.png') });

// 2. error detection, one per compiler stage
const bad = async (sql: string, name: string) => {
  await page.fill('textarea.sql', sql);
  await page.waitForSelector('.diag');
  await editorCard.screenshot({ path: join(out, name) });
};
await bad('SELECT customer_id FROM customers WHERE region = $South', '02a-error-lexical.png');
await bad('SELECT c.name FROM customers c LEFT JOIN orders o ON c.customer_id = o.customer_id', '02b-error-syntax.png');
await bad('SELECT nme, region FROM customers WHERE age = \'x\'', '02c-error-semantic.png');
await bad("SELECT region, COUNT(*) FROM customers GROUP BY segment", '02d-error-semantic-group.png');

// back to the report example
await page.selectOption('#ex', 'g1');
await page.waitForSelector('.ok-note');

// 3. compiler stages
await page.click('button[role=tab]:has-text("Compiler")');
await right.screenshot({ path: join(out, '03-lexer-tokens.png') });
await page.click('button:has-text("4 · Relational IR")');
await right.screenshot({ path: join(out, '04-relational-ir.png') });

// 4. candidates
await page.click('button[role=tab]:has-text("Candidate plans")');
await page.locator('tr.click').nth(6).evaluate((el) => (el as HTMLElement).click());
await right.screenshot({ path: join(out, '05-candidates.png') });

// 5. selectors (and run the predictor's choice)
await page.click('button[role=tab]:has-text("Selector modes")');
await page.waitForSelector('.mode-card .big >> nth=2');
await page.locator('.mode-card button:has-text("Run")').nth(2).click();
await page.waitForSelector('h3:has-text("Mode C")');
await right.screenshot({ path: join(out, '06-selectors.png') });

// 6. benchmark and comparison
await page.click('button[role=tab]:has-text("Benchmark")');
await page.click('button:has-text("Run benchmark")');
await page.waitForSelector('text=candidates matched the SQLite reference', { timeout: 180_000 });
await right.screenshot({ path: join(out, '07-benchmark.png') });
await page.click('button[role=tab]:has-text("Comparison")');
await page.waitForSelector('td:has-text("Oracle")');
await right.screenshot({ path: join(out, '08-comparison.png') });

// 7. held-out evaluation
await page.click('button[role=tab]:has-text("Held-out evaluation")');
await page.waitForSelector('text=Table 4.3');
await right.screenshot({ path: join(out, '09-evaluation.png') });

await browser.close();
console.log('screenshots written to', out);
