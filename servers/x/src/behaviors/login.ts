import "dotenv/config";

import { BrowserContext, Page } from "playwright";
import { chromium, devices } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import path from "path";

import { recordRateLimitHit } from "../utils";

function attachRateLimitListener(page: Page) {
  page.on("response", (response) => {
    if (response.status() !== 429) return;
    const url = response.url();
    if (!url.includes("x.com") && !url.includes("twitter.com")) return;
    recordRateLimitHit(page, { status: 429, url, at: Date.now() });
  });
}

chromium.use(StealthPlugin());

const authDir = process.env.AUTH_DIR || "playwright/.auth";
const authFile = path.join(authDir, "twitter.json");
// A real on-disk Chrome profile. A logged-out x.com is defended against exactly
// the shape `launch()` + `newContext()` produces: a browser with no history, no
// IndexedDB, no service worker cache — brand new every single time. The login
// flow is the point where that matters most, so it gets a profile that persists.
const profileDir = path.join(authDir, "profile");

const MANUAL_LOGIN_TIMEOUT_MS = parseInt(
  process.env.MANUAL_LOGIN_TIMEOUT_MS || "300000",
  10
);

function getProxyConfig() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) {
    return undefined;
  }

  const proxyConfig = {
    server: proxyUrl,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };

  if (proxyUrl.includes("@")) {
    const match = proxyUrl.match(/^(https?:\/\/)(?:([^:]+):([^@]+)@)?(.+)$/);
    if (match) {
      proxyConfig.server = match[1] + match[4];
      proxyConfig.username = proxyConfig.username || match[2];
      proxyConfig.password = proxyConfig.password || match[3];
    }
  }

  console.log("Using proxy config:", proxyConfig);
  return {
    server: proxyConfig.server,
    ...(proxyConfig.username && { username: proxyConfig.username }),
    ...(proxyConfig.password && { password: proxyConfig.password }),
  };
}

async function createBrowser(opts: { headless?: boolean; slowMo?: number } = {}) {
  const proxyConfig = getProxyConfig();
  const headless =
    opts.headless ?? process.env.NODE_ENV !== "development";

  const browser = await chromium.launch({
    timeout: 60000,
    headless,
    // slowMo paces our own actions to look human. During a manual login there
    // are no actions of ours worth pacing — only the cookie poll — and every
    // paced CDP round trip is a second the window spends unresponsive under
    // the user's hands. Callers that hand the window to a person pass 0.
    slowMo: opts.slowMo ?? 1000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
    ],
    ...(proxyConfig && { proxy: proxyConfig }),
  });

  return browser;
}

async function createPersistentContext(
  opts: { headless?: boolean; slowMo?: number } = {}
): Promise<BrowserContext> {
  const proxyConfig = getProxyConfig();
  const context = await chromium.launchPersistentContext(profileDir, {
    timeout: 60000,
    headless: opts.headless ?? true,
    slowMo: opts.slowMo ?? 1000,
    // The real Chrome on this machine, not Playwright's bundled Chromium. x.com
    // gates the login flow's "Next" button on automation checks, and the bundled
    // build fails them: --enable-automation is on by default, and the sandbox
    // flags a headless-CI setup needs are themselves a tell. Override nothing
    // here — a stock Chrome fingerprint is the whole point.
    channel: "chrome",
    ignoreDefaultArgs: ["--enable-automation"],
    // Follow the real window rather than pinning a viewport inside it.
    viewport: null,
    locale: "en-US",
    ...(proxyConfig && { proxy: proxyConfig }),
  });
  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
  );
  return context;
}

function isOnLoginFlow(page: Page) {
  const url = page.url();
  return (
    url.includes("/i/flow/login") ||
    url.includes("twitter.com/login") ||
    url.includes("x.com/login")
  );
}

async function waitForManualLogin(page: Page) {
  console.log(
    `Please log in manually in the visible Chromium window. ` +
      `Waiting up to ${Math.round(
        MANUAL_LOGIN_TIMEOUT_MS / 1000
      )}s for login to complete...`
  );

  const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cookies = await page.context().cookies();
    const authToken = cookies.find(
      (c) =>
        c.name === "auth_token" &&
        (c.domain.includes("x.com") || c.domain.includes("twitter.com"))
    );
    if (authToken && authToken.value) {
      console.log("Login detected. Saving auth state...");
      await saveState(page);
      return;
    }
    await page.waitForTimeout(1500);
  }

  throw new Error(
    `Manual login was not completed within ${Math.round(
      MANUAL_LOGIN_TIMEOUT_MS / 1000
    )}s (no auth_token cookie observed).`
  );
}

async function newContextWithStealth(
  browser: Awaited<ReturnType<typeof createBrowser>>,
  opts: { storageState?: string } = {}
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
  );
  return context;
}

export async function getUnauthenticatedPage() {
  const browser = await createBrowser();
  const context = await newContextWithStealth(browser);
  const page = await context.newPage();
  attachRateLimitListener(page);

  return {
    page,
    close: async () => {
      await page.close();
      await context.close();
      await browser.close();
    },
  };
}

export async function getAuthenticatedPage() {
  let browser = await createBrowser();

  let context: BrowserContext;
  try {
    context = await newContextWithStealth(browser, { storageState: authFile });
  } catch (error) {
    console.log("No auth file found, creating new context...");
    context = await newContextWithStealth(browser);
  }

  let page = await context.newPage();
  attachRateLimitListener(page);
  await page.goto("https://x.com/home");

  if (isOnLoginFlow(page)) {
    console.log(
      "Not logged in. Relaunching browser in visible mode for manual login..."
    );
    await context.close();
    await browser.close();

    browser = await createBrowser({ headless: false, slowMo: 0 });
    context = await newContextWithStealth(browser);

    page = await context.newPage();
    attachRateLimitListener(page);
    await page.goto("https://x.com/i/flow/login");

    await waitForManualLogin(page);
  }

  return {
    page,
    close: async () => {
      await page.close();
      await context.close();
      await browser.close();
    },
  };
}

export async function saveState(page: Page) {
  return page.context().storageState({ path: authFile });
}

export async function login() {
  const context = await createPersistentContext({ headless: false, slowMo: 0 });
  const page = context.pages()[0] ?? (await context.newPage());
  attachRateLimitListener(page);

  await page.goto("https://x.com/i/flow/login");

  await waitForManualLogin(page);

  await context.close();

  console.log("Done!");
}
