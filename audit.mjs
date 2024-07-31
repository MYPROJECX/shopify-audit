import { AxePuppeteer } from 'axe-puppeteer';
import { launch } from 'chrome-launcher';
import dotenv from 'dotenv';
import esMain from 'es-main';
import fs from 'fs';
import lighthouse from 'lighthouse';
import path from 'path';
import puppeteer from 'puppeteer';

dotenv.config();

const config = {
  domain: process.env.WEBSITE,
  password: process.env.PASSWORD,
  chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'],
  viewport: {
    mobile: {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
    desktop: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  emulatedUserAgent: {
    mobile: 'Mozilla/5.0 (Android 10; Mobile; rv:88.0) Gecko/88.0 Firefox/88.0',
    desktop:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  },
  urls: [
    '/account/login',
    '/cart',
    '/collections/stationary',
    '/collections',
    '/pages/about',
    '/products/spiral-notebook',
    '/search?q=note',
    '/search',
    '',
  ],
  timeout: 60000,
  maxRetries: 3,
};

function createDirectoryIfNotExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function login(page, origin) {
  console.log('Logging in at:', origin);
  await page.goto(origin, {
    waitUntil: 'networkidle2',
    timeout: config.timeout,
  });
  await page.waitForSelector('input[type="password"]', { visible: true });
  await page.type('input[type="password"]', config.password);
  await Promise.all([
    page.$eval('.password-form', (form) => form.submit()),
    page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: config.timeout,
    }),
  ]);
  console.log('Logged in successfully');
}

async function runLighthouse(url, port, isMobile, reportPath) {
  console.log(
    `Running Lighthouse audit for ${isMobile ? 'mobile' : 'desktop'} on: ${url}`
  );

  const formFactor = isMobile ? 'mobile' : 'desktop';
  const screenEmulation = {
    ...config.viewport[formFactor],
    mobile: isMobile,
  };
  const emulatedUserAgent = config.emulatedUserAgent[formFactor];

  const result = await lighthouse(url, {
    disableStorageReset: true,
    formFactor,
    onlyCategories: [
      'performance',
      'accessibility',
      'best-practices',
      'seo',
      'pwa',
    ],
    output: 'html',
    port,
    screenEmulation,
    emulatedUserAgent,
  });

  createDirectoryIfNotExists(path.dirname(reportPath));
  fs.writeFileSync(reportPath, result.report);
  console.log(`Lighthouse report saved to ${reportPath}`);
}

async function runAxe(page, url, reportPath, isMobile) {
  console.log(
    `Running Axe accessibility audit for ${isMobile ? 'mobile' : 'desktop'} on: ${url}`
  );

  const results = await new AxePuppeteer(page).analyze();
  createDirectoryIfNotExists(path.dirname(reportPath));
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Axe report saved to ${reportPath}`);
}

async function navigateWithRetries(page, url, maxRetries = config.maxRetries) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: config.timeout,
      });
      return;
    } catch (error) {
      attempts++;
      console.error(
        `Failed to navigate to ${url} (attempt ${attempts}/${maxRetries}):`,
        error
      );
      if (attempts >= maxRetries) {
        throw new Error(
          `Failed to navigate to ${url} after ${maxRetries} attempts`
        );
      }
    }
  }
}

function getSafeFilename(url) {
  const relativeUrl = new URL(url, config.domain).pathname;
  return relativeUrl.slice(1).replace(/[^a-zA-Z0-9]/g, '_');
}

async function runAuditsForUrls(urls, loginUrl) {
  console.log('Launching Chrome');

  const chrome = await launch({ chromeFlags: config.chromeFlags });
  const response = await fetch(`http://localhost:${chrome.port}/json/version`);
  const { webSocketDebuggerUrl } = await response.json();
  const browser = await puppeteer.connect({
    browserWSEndpoint: webSocketDebuggerUrl,
  });
  const page = await browser.newPage();

  await login(page, loginUrl);

  for (const relativeUrl of urls) {
    const url = `${config.domain}${relativeUrl}`;
    const safeFilename = getSafeFilename(url);

    try {
      await navigateWithRetries(page, url);
    } catch (error) {
      console.error(`Skipping ${url} due to repeated navigation failures.`);
      continue;
    }

    await runLighthouse(
      url,
      chrome.port,
      true,
      path.join('lighthouse', 'mobile', `${safeFilename}_mobile.html`)
    );

    await runLighthouse(
      url,
      chrome.port,
      false,
      path.join('lighthouse', 'desktop', `${safeFilename}_desktop.html`)
    );

    await page.setViewport(config.viewport.mobile);
    await runAxe(
      page,
      url,
      path.join('axe', 'mobile', `${safeFilename}_mobile.json`),
      true
    );

    await page.setViewport(config.viewport.desktop);
    await runAxe(
      page,
      url,
      path.join('axe', 'desktop', `${safeFilename}_desktop.json`),
      false
    );
  }

  await browser.close();
  await chrome.kill();
  console.log('Chrome instance closed');
}

async function main() {
  await runAuditsForUrls(config.urls, `${config.domain}/password`);
}

if (esMain(import.meta)) {
  main().catch(console.error);
}

export { login };
