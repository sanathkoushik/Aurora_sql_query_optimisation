/**
 * Browser end-to-end check of the live demo (needs Chrome and internet for the Pyodide CDN).
 *   npm run build && npx tsx scripts/e2e.ts
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT } from './lib/nodeRuntime';

const shots = join(ROOT, 'artifacts', 'screenshots');
const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: ROOT, shell: true, stdio: 'ignore' });
const fail: string[] = [];
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fail.push(msg); };

try {
  await new Promise((r) => setTimeout(r, 4000));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('http://localhost:4173/');

  await page.waitForSelector('.pill:has-text("Pyodide")', { timeout: 180_000 });
  check(true, 'Pyodide + pandas booted in the browser');
  await page.waitForSelector('table:has-text("customers")', { timeout: 60_000 });
  check(true, 'dataset profile generated and listed');
  check(await page.locator('.pill:has-text("aurora-rf-v1")').count() === 1, 'predictor model loaded');

  // Compiler tab
  check(await page.locator('.ok-note').innerText().then((t) => t.includes('Compiled')), 'default query compiles');
  for (const v of ['2 · Parser', '3 · Semantic', '4 · Relational IR']) await page.click(`button:has-text("${v}")`);
  check(await page.locator('.tree .node').count() > 3, 'IR tree rendered');
  await page.screenshot({ path: join(shots, '1-compiler.png') });

  // Diagnostics for bad SQL
  await page.fill('textarea.sql', 'SELECT nme FROM customers');
  check(await page.locator('.diag').innerText().then((t) => t.includes("Did you mean 'name'")), 'semantic diagnostic with suggestion');
  await page.fill('textarea.sql', 'SELECT a FROM t LEFT JOIN u ON t.a=u.a');
  check(await page.locator('.diag').innerText().then((t) => t.includes('LEFT is not supported')), 'unsupported syntax diagnostic');
  await page.selectOption('#ex', 'g1');

  // Candidates
  await page.click('button[role=tab]:has-text("Candidate plans")');
  check(await page.locator('tr.click').count() >= 10, 'candidate table lists plans');
  await page.locator('tr.click').nth(6).click();
  check(await page.locator('pre.code:has-text("def run(T)")').count() === 1, 'pandas code shown');
  await page.screenshot({ path: join(shots, '2-candidates.png') });

  // Selectors
  await page.click('button[role=tab]:has-text("Selector modes")');
  await page.waitForSelector('.mode-card .big >> nth=2', { timeout: 30_000 });
  const picks = await page.locator('.mode-card .big').allInnerTexts();
  check(picks.length === 4 && picks.every((p) => /^P\d+$/.test(p)), `four modes picked plans: ${picks.join(', ')}`);
  await page.locator('.mode-card button:has-text("Run")').nth(2).click();
  await page.waitForSelector('h3:has-text("Mode C")', { timeout: 30_000 });
  check(true, 'selected plan executed and rows displayed');
  await page.screenshot({ path: join(shots, '3-selectors.png'), fullPage: true });

  // Benchmark + comparison
  await page.click('button[role=tab]:has-text("Benchmark")');
  await page.click('button:has-text("Run benchmark")');
  await page.waitForSelector('text=candidates matched the SQLite reference', { timeout: 180_000 });
  const eq = await page.locator('p.small:has-text("matched the SQLite reference")').innerText();
  check(/12\/12/.test(eq), `all candidates equivalent in browser (${eq.trim().slice(0, 60)})`);
  await page.screenshot({ path: join(shots, '4-benchmark.png'), fullPage: true });
  await page.click('button[role=tab]:has-text("Comparison")');
  check(await page.locator('td:has-text("Oracle")').count() === 1, 'comparison table with oracle row');
  await page.screenshot({ path: join(shots, '5-comparison.png'), fullPage: true });

  // Evaluation
  await page.click('button[role=tab]:has-text("Held-out evaluation")');
  await page.waitForSelector('text=Table 4.3', { timeout: 15_000 });
  check(await page.locator('text=inconclusive').count() > 0 && await page.locator('text=Combined predictor').count() > 0, 'held-out evaluation shows all modes and the honest verdicts');
  await page.screenshot({ path: join(shots, '6-evaluation.png'), fullPage: true });

  // switching profile + dark mode + mobile
  await page.selectOption('#prof', 'small_broad');
  await page.waitForSelector('td:has-text("5,000")', { timeout: 60_000 });
  check(true, 'switching data profile regenerates the tables');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(shots, '7-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'no horizontal page overflow at phone width');
  await page.screenshot({ path: join(shots, '8-mobile.png') });

  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
} finally {
  server.kill();
  spawn('taskkill', ['/F', '/IM', 'node.exe', '/FI', 'WINDOWTITLE eq vite*'], { stdio: 'ignore' });
}
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall browser checks passed');
process.exit(fail.length ? 1 : 0);
