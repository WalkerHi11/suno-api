import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { AsyncSemaphore, isPage, sleep } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
// Keep the default model overridable from env so MCP callers can track Suno model updates
// without patching source again.
export const DEFAULT_MODEL = process.env.SUNO_DEFAULT_MODEL || 'v5.5';
const DEFAULT_USE_PERSONA = yn(process.env.SUNO_DEFAULT_USE_PERSONA, { default: false }) ?? false;
const DEFAULT_PERSONA_NAME = process.env.SUNO_DEFAULT_PERSONA_NAME || '';
const DEFAULT_PERSONA_ID = process.env.SUNO_DEFAULT_PERSONA_ID || '';
const DEFAULT_TASK = process.env.SUNO_DEFAULT_TASK || '';

const CAPTCHA_MAX_CONCURRENT =
  Number.parseInt(process.env.SUNO_MAX_CONCURRENT_CAPTCHAS || '', 10) || 1;
const CAPTCHA_MAX_QUEUE =
  Number.parseInt(process.env.SUNO_MAX_QUEUED_CAPTCHAS || '', 10) || 20;
const CAPTCHA_ACQUIRE_TIMEOUT_MS =
  Number.parseInt(process.env.SUNO_CAPTCHA_ACQUIRE_TIMEOUT_MS || '', 10) || 240_000;
const TRANSIENT_CREATE_RETRIES =
  Number.parseInt(process.env.SUNO_TRANSIENT_CREATE_RETRIES || '', 10) || 1;
const CAPTCHA_SKIP_HCAPTCHA_TOKEN_SOLVE =
  yn(process.env.SUNO_SKIP_HCAPTCHA_TOKEN_SOLVE, { default: false }) ?? false;
const CAPTCHA_MAX_CHALLENGE_ROUNDS =
  Number.parseInt(process.env.CAPTCHA_MAX_CHALLENGE_ROUNDS || '', 10) || 12;
const CAPTCHA_POST_SUBMIT_WAIT_MS =
  Number.parseInt(process.env.CAPTCHA_POST_SUBMIT_WAIT_MS || '', 10) || 4_000;
const CAPTCHA_REFRESH_AFTER_ROUNDS =
  Number.parseInt(process.env.CAPTCHA_REFRESH_AFTER_ROUNDS || '', 10) || 3;

const captchaSemaphore = new AsyncSemaphore(CAPTCHA_MAX_CONCURRENT, CAPTCHA_MAX_QUEUE);

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out in ${label} after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function sunoApiHealth() {
  return {
    ok: true,
    captcha_semaphore: captchaSemaphore.stats(),
    defaults: {
      model: DEFAULT_MODEL,
      use_persona: DEFAULT_USE_PERSONA,
      persona_name: DEFAULT_PERSONA_NAME,
      persona_id: DEFAULT_PERSONA_ID,
      task: DEFAULT_TASK,
    },
  };
}

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface GenerationOptions {
  use_persona?: boolean;
  persona_id?: string;
  task?: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api-prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';
  private static CLERK_VERSION = '5.15.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;
  private latestPersonaId?: string;

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'Origin': 'https://suno.com',
        'Referer': 'https://suno.com/create',
        'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private isTransientCreateError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return [
      'Execution context was destroyed',
      'most likely because of a navigation',
      'Target closed',
      'frame was detached',
      'has been closed'
    ].some((snippet) => message.includes(snippet));
  }

  private async withTransientCreateRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= TRANSIENT_CREATE_RETRIES || !this.isTransientCreateError(error)) {
          throw error;
        }
        logger.warn(
          {
            label,
            attempt: attempt + 1,
            max_retries: TRANSIENT_CREATE_RETRIES,
            error: error instanceof Error ? error.message : String(error)
          },
          'Retrying transient Suno create flow error'
        );
        await sleep(2, 3);
      }
    }
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Clicks on a locator or XY vector. This method is made because of the difference between ghost-cursor-playwright and Playwright methods
   */
  private async click(target: Locator|Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) 
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  /**
   * Get the BrowserType from the `BROWSER` environment variable.
   * @returns {BrowserType} chromium, firefox or webkit. Default is chromium
   */
  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      /*case 'webkit': ** doesn't work with rebrowser-patches
      case 'safari':
        return webkit;*/
      default:
        return chromium;
    }
  }

  /**
   * Launches a browser with the necessary cookies
   * @returns {BrowserContext}
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const headless =
      yn(process.env.BROWSER_HEADLESS, { default: true }) || !process.env.DISPLAY;
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars',
      '--disable-background-networking',
      '--disable-popup-blocking',
      '--disable-sync',
      '--metrics-recording-only',
      '--safebrowsing-disable-auto-update'
    ];
    // Check for GPU acceleration, as it is recommended to turn it off for Docker
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless
    });
    const context = await browser.newContext({
      userAgent: this.userAgent,
      locale: process.env.BROWSER_LOCALE || 'en',
      viewport: null
    });
    const cookies = [];
    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    cookies.push({
      name: '__session',
      value: this.currentToken+'',
      domain: '.suno.com',
      path: '/',
      sameSite: lax
    });
    for (const key in this.cookies) {
      cookies.push({
        name: key,
        value: this.cookies[key]+'',
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      })
    }
    await context.addCookies(cookies);
    return context;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    if (!await this.captchaRequired())
      return null;

    const acquireStart = Date.now();
    logger.info({ sem: captchaSemaphore.stats() }, 'Waiting for captcha capacity');
    const release = await captchaSemaphore.acquire({ timeoutMs: CAPTCHA_ACQUIRE_TIMEOUT_MS });
    logger.info({ waited_ms: Date.now() - acquireStart, sem: captchaSemaphore.stats() }, 'Acquired captcha capacity');

    try {
      logger.info('CAPTCHA required. Launching browser...')
      const browser = await this.launchBrowser();
      let browserClosed = false;
      const closeBrowser = async () => {
        if (browserClosed) return;
        browserClosed = true;
        await browser.browser()?.close();
      };

      // Default raised from 120s -> 180s to reduce false negatives when Suno UI is slow.
      const createUiReadyTimeoutMs = Number.parseInt(process.env.CAPTCHA_UI_READY_TIMEOUT_MS || '', 10) || 180_000;
      const gotoTimeoutMs = Number.parseInt(process.env.BROWSER_GOTO_TIMEOUT_MS || '', 10) || 60_000;

      try {
        // Navigation with retry logic
        let page: Page | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            page = await browser.newPage();
            await page.addInitScript(() => {
              const w = window as any;
              w.__cfTurnstileCaptured = null;
              w.__cfTurnstileCallback = null;
              w.__hCaptchaCaptured = null;
              w.__hCaptchaCallback = null;
              w.__hCaptchaExecuted = false;
              let turnstileValue: any = undefined;
              let hcaptchaValue: any = undefined;
              let grecaptchaValue: any = undefined;

              const installHook = (ts: any) => {
                if (!ts || ts.__sunoHooked)
                  return false;
                const originalRender = ts.render?.bind(ts);
                if (typeof originalRender !== 'function')
                  return false;
                ts.render = (...args: any[]) => {
                  const [, options] = args;
                  w.__cfTurnstileCaptured = {
                    sitekey: options?.sitekey,
                    pageurl: window.location.href,
                    data: options?.cData,
                    pagedata: options?.chlPageData,
                    action: options?.action,
                    userAgent: navigator.userAgent,
                    json: 1,
                  };
                  w.__cfTurnstileCallback = options?.callback ?? null;
                  return originalRender(...args);
                };
                ts.__sunoHooked = true;
                return true;
              };

              const installHCaptchaHook = (captcha: any) => {
                if (!captcha || captcha.__sunoHCaptchaHooked)
                  return false;

                const originalRender = captcha.render?.bind(captcha);
                if (typeof originalRender === 'function') {
                  captcha.render = (...args: any[]) => {
                    const [, options] = args;
                    w.__hCaptchaCaptured = {
                      sitekey: options?.sitekey,
                      pageurl: window.location.href,
                      invisible: options?.size === 'invisible' ? 1 : 0,
                      data: options?.rqdata,
                      userAgent: navigator.userAgent,
                    };
                    w.__hCaptchaCallback = options?.callback ?? null;
                    return originalRender(...args);
                  };
                }

                const originalExecute = captcha.execute?.bind(captcha);
                if (typeof originalExecute === 'function') {
                  captcha.execute = (...args: any[]) => {
                    w.__hCaptchaExecuted = true;
                    return originalExecute(...args);
                  };
                }

                captcha.__sunoHCaptchaHooked = true;
                return true;
              };

              Object.defineProperty(w, 'turnstile', {
                configurable: true,
                get() {
                  return turnstileValue;
                },
                set(value) {
                  turnstileValue = value;
                  installHook(value);
                },
              });

              Object.defineProperty(w, 'hcaptcha', {
                configurable: true,
                get() {
                  return hcaptchaValue;
                },
                set(value) {
                  hcaptchaValue = value;
                  installHCaptchaHook(value);
                },
              });

              Object.defineProperty(w, 'grecaptcha', {
                configurable: true,
                get() {
                  return grecaptchaValue;
                },
                set(value) {
                  grecaptchaValue = value;
                  installHCaptchaHook(value);
                },
              });

              if (w.turnstile)
                installHook(w.turnstile);
              if (w.hcaptcha)
                installHCaptchaHook(w.hcaptcha);
              if (w.grecaptcha)
                installHCaptchaHook(w.grecaptcha);
            });
            await page.goto('https://suno.com/create', {
              referer: 'https://www.google.com/',
              waitUntil: 'domcontentloaded',
              timeout: gotoTimeoutMs
            });
            break;
          } catch (e) {
            logger.warn(`Navigation attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
            if (attempt === 2) throw e;
            await page?.close().catch(() => {});
            await sleep(2);
          }
        }
        if (!page) throw new Error('Failed to create page after retries');

    const pickLargest = async (locator: Locator): Promise<Locator | null> => {
      const count = await locator.count();
      let bestIndex = -1;
      let bestArea = -1;
      for (let i = 0; i < count; i++) {
        const candidate = locator.nth(i);
        if (!await candidate.isVisible())
          continue;
        const box = await candidate.boundingBox();
        if (!box) continue;
        const area = box.width * box.height;
        if (area > bestArea) {
          bestArea = area;
          bestIndex = i;
        }
      }
      return bestIndex >= 0 ? locator.nth(bestIndex) : null;
    };

    const waitForCreateReady = async (): Promise<void> => {
      const deadline = Date.now() + createUiReadyTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const prompt = await pickLargest(
            page.locator('.custom-textarea, textarea, [contenteditable="true"], [role="textbox"]')
          );
          const createButton = await pickLargest(
            page.locator('button[aria-label="Create song"], button[aria-label*="Create"], button:has-text("Create")')
          );
          if (prompt && createButton) return;
          await page.waitForTimeout(250);
        } catch (e) {
          if (page.isClosed()) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          const isTransient =
            msg.includes('Execution context was destroyed') ||
            msg.includes('most likely because of a navigation') ||
            msg.includes('Navigation') ||
            msg.includes('Target closed') ||
            msg.includes('has been closed') ||
            msg.includes('frame was detached');
          if (!isTransient) throw e;
          await page.waitForTimeout(250);
        }
      }
      throw new Error(`Timed out after ${createUiReadyTimeoutMs}ms`);
    };

    logger.info('Waiting for Suno interface to load');
    try {
      const readyPromise = waitForCreateReady();
      // If we hit our own timeout below, avoid an unhandled rejection from the still-running promise.
      readyPromise.catch(() => {});
      await withTimeout(readyPromise, createUiReadyTimeoutMs + 5_000, "waitForCreateReady");
    } catch (e) {
      const debugId = Date.now();
      const debugDir = process.env.CAPTCHA_DEBUG_DIR || '/tmp';
      const screenshotPath = path.join(debugDir, `suno-create-not-ready-${debugId}.png`);
      const htmlPath = path.join(debugDir, `suno-create-not-ready-${debugId}.html`);
      await withTimeout(page.screenshot({ path: screenshotPath, fullPage: true }), 15_000, "page.screenshot").catch(() => {});
      const html = await withTimeout(page.content(), 15_000, "page.content").catch(() => "");
      if (html) await fs.writeFile(htmlPath, html).catch(() => {});
      throw new Error(
        `Suno /create did not become ready within ${createUiReadyTimeoutMs}ms (url=${page.url()}). Debug saved: ${screenshotPath} ${htmlPath}. Original error: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);
    
    logger.info('Triggering the CAPTCHA');
    try {
      await page.getByLabel('Close').click({ timeout: 2000 }); // close all popups
    } catch(e) {}

    const tokenTimeoutMs = Number.parseInt(process.env.CAPTCHA_TOKEN_TIMEOUT_MS || '', 10) || 180_000;
    const controller = new AbortController();
    let settled = false;

    const shutdown = async () => {
      try { controller.abort(); } catch {}
      try { await closeBrowser(); } catch {}
    };

    const findPromptInput = async (): Promise<Locator> => {
      const strategies = [
        page.locator('.custom-textarea'),
        page.locator('textarea'),
        page.locator('[contenteditable="true"]'),
        page.locator('[role="textbox"]'),
      ];
      for (const strat of strategies) {
        const picked = await pickLargest(strat);
        if (picked) return picked;
      }
      throw new Error('Could not find a prompt input on https://suno.com/create (UI may have changed).');
    };

    const findCreateButton = async (): Promise<Locator> => {
      const strategies = [
        page.locator('button[aria-label="Create song"]'),
        page.locator('button[aria-label*="Create"]'),
        page.getByRole('button', { name: /^Create$/i }),
        page.getByRole('button', { name: /Create/i }),
      ];
      for (const strat of strategies) {
        const picked = await pickLargest(strat);
        if (picked) return picked;
      }
      throw new Error('Could not find the Create button on https://suno.com/create (UI may have changed).');
    };

    const dismissBlockingDialogs = async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.getByLabel('Close').click({ timeout: 1_000 }).catch(() => {});
      await page.locator('[role="dialog"] button').filter({ hasText: /close|skip|not now|maybe later/i }).first().click({ timeout: 1_000 }).catch(() => {});
      await page.evaluate(() => {
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
          (dialog as HTMLElement).remove();
        }
        for (const overlay of document.querySelectorAll('[data-radix-dialog-overlay], [data-radix-portal], [data-state="open"][style*="pointer-events"]')) {
          if (overlay instanceof HTMLElement)
            overlay.style.display = 'none';
        }
        document.body.style.pointerEvents = 'auto';
        document.body.style.overflow = 'auto';
      }).catch(() => {});
    };

    const populatePromptInput = async (input: Locator, value: string) => {
      await dismissBlockingDialogs();
      await input.click();
      try {
        await input.fill('');
      } catch {}

      await input.evaluate((el) => {
        const element = el as HTMLElement & { value?: string };
        if ('value' in element)
          (element as HTMLInputElement | HTMLTextAreaElement).value = '';
        else
          element.textContent = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});

      await input.click();
      await page.keyboard.type(value, { delay: 20 });

      await input.evaluate((el, prompt) => {
        const element = el as HTMLElement & { value?: string };
        if ('value' in element)
          (element as HTMLInputElement | HTMLTextAreaElement).value = prompt as string;
        else
          element.textContent = prompt as string;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value).catch(() => {});

      await page.keyboard.press('Tab').catch(() => {});
    };

    await dismissBlockingDialogs();
    const textarea = await findPromptInput();
    await populatePromptInput(textarea, 'Lorem ipsum');

    const button = await findCreateButton();

    const waitForTurnstileParams = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let params: any;
        try {
          params = await page.evaluate(() => (window as any).__cfTurnstileCaptured ?? null);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isTransient =
            msg.includes('Execution context was destroyed') ||
            msg.includes('most likely because of a navigation') ||
            msg.includes('Navigation') ||
            msg.includes('Target closed') ||
            msg.includes('has been closed') ||
            msg.includes('frame was detached');
          if (!isTransient) throw e;
          await page.waitForTimeout(250);
          continue;
        }
        if (params?.sitekey)
          return params;
        await page.waitForTimeout(250);
      }
      return null;
    };

    const solveTurnstile = async (): Promise<boolean> => {
      const params = await waitForTurnstileParams(15_000);
      if (!params)
        return false;

      logger.info(
        {
          sitekey: params.sitekey,
          action: params.action,
          has_data: Boolean(params.data),
          has_pagedata: Boolean(params.pagedata),
        },
        'Solving Cloudflare Turnstile'
      );

      const result: any = await (this.solver as any).cloudflareTurnstile(params);
      const token = result?.data;
      if (!token)
        throw new Error('Cloudflare Turnstile solver returned no token');

      await page.evaluate((turnstileToken: string) => {
        const w = window as any;
        if (typeof w.__cfTurnstileCallback === 'function')
          w.__cfTurnstileCallback(turnstileToken);

        const selectors = [
          'input[name="cf-turnstile-response"]',
          'textarea[name="cf-turnstile-response"]',
          'input[name="g-recaptcha-response"]',
          'textarea[name="g-recaptcha-response"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el)
            continue;
          el.value = turnstileToken;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, token);

      logger.info('Cloudflare Turnstile token injected');
      return true;
    };

    const waitForHCaptchaParams = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let params: any;
        try {
          params = await page.evaluate(() => {
            const w = window as any;
            if (!w.__hCaptchaCaptured?.sitekey)
              return null;
            return {
              ...w.__hCaptchaCaptured,
              executed: Boolean(w.__hCaptchaExecuted),
            };
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isTransient =
            msg.includes('Execution context was destroyed') ||
            msg.includes('most likely because of a navigation') ||
            msg.includes('Navigation') ||
            msg.includes('Target closed') ||
            msg.includes('has been closed') ||
            msg.includes('frame was detached');
          if (!isTransient) throw e;
          await page.waitForTimeout(250);
          continue;
        }
        if (params?.sitekey)
          return params;
        await page.waitForTimeout(250);
      }
      return null;
    };

    const solveHCaptchaToken = async (): Promise<boolean> => {
      const params = await waitForHCaptchaParams(20_000);
      if (!params)
        return false;

      logger.info(
        {
          sitekey: params.sitekey,
          invisible: Boolean(params.invisible),
          executed: Boolean(params.executed),
          has_data: Boolean(params.data),
        },
        'Solving hCaptcha token'
      );

      const payload: Record<string, unknown> = {
        pageurl: params.pageurl || page.url(),
        sitekey: params.sitekey,
        invisible: params.invisible ? 1 : 0,
      };
      if (params.data) {
        payload.data = params.data;
        payload.userAgent = params.userAgent || this.userAgent;
      } else if (params.userAgent) {
        payload.userAgent = params.userAgent;
      }

      const result: any = await (this.solver as any).hcaptcha(payload);
      const token = result?.data;
      if (!token)
        throw new Error('hCaptcha solver returned no token');

      await page.evaluate((captchaToken: string) => {
        const w = window as any;
        const selectors = [
          'input[name="h-captcha-response"]',
          'textarea[name="h-captcha-response"]',
          'input[name="g-recaptcha-response"]',
          'textarea[name="g-recaptcha-response"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el)
            continue;
          el.value = captchaToken;
          el.innerHTML = captchaToken;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (typeof w.__hCaptchaCallback === 'function')
          w.__hCaptchaCallback(captchaToken);
      }, token);

      logger.info('hCaptcha token injected');
      return true;
    };

    let resolveToken!: (token: string) => void;
    let rejectToken!: (err: Error) => void;
    const tokenPromise = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    const finishOk = async (token: string) => {
      if (settled) return;
      settled = true;
      await shutdown();
      resolveToken(token);
    };

    const finishErr = async (err: unknown) => {
      if (settled) return;
      settled = true;
      await shutdown();
      rejectToken(err instanceof Error ? err : new Error(String(err)));
    };

    const timeout = setTimeout(() => finishErr(new Error(`Timed out waiting for hCaptcha token after ${tokenTimeoutMs}ms`)), tokenTimeoutMs);

    await page.route(/\/api\/generate\/v2\/?/, async (route: any) => {
      try {
        logger.info('hCaptcha token received. Closing browser');
        await route.abort();
        const request = route.request();
        const auth = request.headers().authorization;
        if (auth && auth.includes('Bearer '))
          this.currentToken = auth.split('Bearer ').pop();
        clearTimeout(timeout);
        await finishOk(request.postDataJSON().token);
      } catch(err) {
        clearTimeout(timeout);
        await finishErr(err);
      }
    });

    const challengeFrameSelector =
      'iframe[title*="hCaptcha challenge"], iframe[title*="Main content of the hCaptcha challenge"], iframe[src*="hcaptcha"][src*="frame=challenge"], iframe[src*="challenge-platform"], iframe[src*="hcaptcha.com/captcha"]';
    const widgetFrameSelector =
      'iframe[title*="checkbox"], iframe[title*="hCaptcha"], iframe[src*="hcaptcha"][src*="checkbox"], iframe[src*="hcaptcha.com/captcha"]';

    const clickHCaptchaWidgetIfPresent = async () => {
      const frames = page.locator(widgetFrameSelector);
      const count = await frames.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const frame = frames.nth(i);
        const title = (await frame.getAttribute('title').catch(() => '')) || '';
        if (title.toLowerCase().includes('challenge'))
          continue;
        if (!await frame.isVisible().catch(() => false))
          continue;
        const box = await frame.boundingBox().catch(() => null);
        if (!box)
          continue;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        logger.info({ title }, 'Clicked hCaptcha widget iframe');
        return true;
      }
      return false;
    };

    const waitForHCaptchaChallengeFrame = async () => {
      const initialWaitMs = Number.parseInt(process.env.CAPTCHA_INITIAL_WAIT_MS || '', 10) || 120000;
      const deadline = Date.now() + initialWaitMs;
      let widgetClickedAt = 0;

      while (Date.now() < deadline) {
        if (controller.signal.aborted)
          throw new Error('AbortError');

        try {
          const frames = page.locator(challengeFrameSelector);
          const count = await frames.count().catch(() => 0);
          if (count > 0) {
            const ready = await page
              .frameLocator(challengeFrameSelector)
              .first()
              .locator('.challenge-container')
              .count()
              .catch(() => 0);
            if (ready > 0)
              return;
          }

          if (Date.now() - widgetClickedAt > 2_000) {
            const clicked = await clickHCaptchaWidgetIfPresent().catch(() => false);
            if (clicked)
              widgetClickedAt = Date.now();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isTransient =
            msg.includes('Execution context was destroyed') ||
            msg.includes('most likely because of a navigation') ||
            msg.includes('Navigation') ||
            msg.includes('Target closed') ||
            msg.includes('has been closed') ||
            msg.includes('frame was detached');
          if (!isTransient) throw e;
        }

        await page.waitForTimeout(500);
      }

      const iframeSummary = await page.locator('iframe').evaluateAll((els) =>
        els.map((el) => ({
          title: el.getAttribute('title'),
          src: el.getAttribute('src'),
        }))
      ).catch(() => []);
      const frameUrls = page.frames().map((frame) => frame.url());
      throw new Error(
        `No hCaptcha request occurred within ${initialWaitMs / 1000} seconds. iframes=${JSON.stringify(iframeSummary)} frames=${JSON.stringify(frameUrls)}`
      );
    };

    const solveHCaptchaChallenge = async () => {
      const frame = page.frameLocator(challengeFrameSelector).first();
      const challenge = frame.locator('.challenge-container');
      let rounds = 0;
      let wait = true;
      while (true) {
        if (settled || controller.signal.aborted)
          return;
        rounds++;
        if (rounds > CAPTCHA_MAX_CHALLENGE_ROUNDS) {
          const promptText = await challenge.locator('.prompt-text').first().innerText().catch(() => '');
          throw new Error(
            `hCaptcha interactive solve exceeded ${CAPTCHA_MAX_CHALLENGE_ROUNDS} rounds (prompt=${JSON.stringify(promptText)})`
          );
        }
        if (wait)
          await waitForHCaptchaChallengeFrame();
        const promptText = await challenge.locator('.prompt-text').first().innerText().catch(() => '');
        const drag = promptText.toLowerCase().includes('drag');
        let captcha: any;
        for (let j = 0; j < 3; j++) { // try several times because sometimes 2Captcha could return an error
          try {
            logger.info('Sending the CAPTCHA to 2Captcha');
            const payload: paramsCoordinates = {
              body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
              lang: process.env.BROWSER_LOCALE
            };
            if (drag) {
              // Say to the worker that he needs to click
              payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
              payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
            } else if (promptText) {
              payload.textinstructions = promptText.replace(/\s+/g, ' ').trim().slice(0, 140);
            }
            captcha = await this.solver.coordinates(payload);
            break;
          } catch(err: any) {
            logger.info(err.message);
            if (j != 2)
              logger.info('Retrying...');
            else
              throw err;
          }
        } 
        if (drag) {
          const challengeBox = await challenge.boundingBox();
          if (challengeBox == null)
            throw new Error('.challenge-container boundingBox is null!');
          if (captcha.data.length % 2) {
            logger.info('Solution does not have even amount of points required for dragging. Requesting new solution...');
            this.solver.badReport(captcha.id);
            wait = false;
            continue;
          }
          for (let i = 0; i < captcha.data.length; i += 2) {
            const data1 = captcha.data[i];
            const data2 = captcha.data[i+1];
            logger.info(JSON.stringify(data1) + JSON.stringify(data2));
            await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
            await page.mouse.down();
            await sleep(1.1); // wait for the piece to be 'unlocked'
            await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, { steps: 30 });
            await page.mouse.up();
          }
          wait = true;
        } else {
          for (const data of captcha.data) {
            logger.info(data);
            await this.click(challenge, { x: +data.x, y: +data.y });
          };
        }
        try {
          await this.click(frame.locator('.button-submit'));
        } catch (e: any) {
          // when hCaptcha window has been closed due to inactivity, retry by clicking Create again
          if (e?.message?.includes('viewport')) {
            await this.click(button);
          } else {
            throw e;
          }
        }

        // Give Suno time to either accept the challenge and fire /api/generate/v2
        // or update the challenge UI before we request another worker answer.
        await Promise.race([
          tokenPromise.then(() => undefined).catch(() => undefined),
          page.waitForTimeout(CAPTCHA_POST_SUBMIT_WAIT_MS),
        ]);
        if (settled || controller.signal.aborted)
          return;

        if (rounds % CAPTCHA_REFRESH_AFTER_ROUNDS === 0) {
          await frame.locator('.button-reload, [aria-label*="refresh"], [title*="refresh"]').first().click({ timeout: 1000 }).catch(() => {});
          wait = true;
        }
      }
    };

    // Ensure the Create button becomes enabled after filling a prompt.
    const enabledDeadline = Date.now() + 10_000;
    while (Date.now() < enabledDeadline) {
      if (await button.isEnabled()) break;
      await page.waitForTimeout(250);
    }
    if (!await button.isEnabled()) {
      const debugId = Date.now();
      const debugDir = process.env.CAPTCHA_DEBUG_DIR || '/tmp';
      const screenshotPath = path.join(debugDir, `suno-create-disabled-${debugId}.png`);
      const htmlPath = path.join(debugDir, `suno-create-disabled-${debugId}.html`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await fs.writeFile(htmlPath, await page.content()).catch(() => {});
      throw new Error(`Create button stayed disabled after filling prompt. Debug saved: ${screenshotPath} ${htmlPath}`);
    }

        // Trigger captcha by attempting a create.
        await this.click(button);

        try {
          const solvedTurnstile = await solveTurnstile();
          if (!solvedTurnstile) {
            let solvedHCaptchaToken = false;
            if (!CAPTCHA_SKIP_HCAPTCHA_TOKEN_SOLVE) {
              try {
                solvedHCaptchaToken = await solveHCaptchaToken();
              } catch (e) {
                logger.warn(
                  { error: e instanceof Error ? e.message : String(e) },
                  'hCaptcha token solve failed; falling back to interactive challenge'
                );
              }
            } else {
              logger.info('Skipping hCaptcha token solve because SUNO_SKIP_HCAPTCHA_TOKEN_SOLVE is enabled');
            }

            if (!solvedHCaptchaToken) {
              logger.info('No token-based captcha params detected after Create; falling back to interactive hCaptcha solver');
              solveHCaptchaChallenge().catch(async (e) => {
                clearTimeout(timeout);
                await finishErr(e);
              });
            }
          }
        } catch (e) {
          clearTimeout(timeout);
          await finishErr(e);
        }

        return await tokenPromise;
      } finally {
        await closeBrowser().catch(() => {});
      }
    } finally {
      release();
      logger.info({ sem: captchaSemaphore.stats() }, 'Released captcha capacity');
    }
  }

  /**
   * Imitates Cloudflare Turnstile loading error. Unused right now, left for future
   */
  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    options: GenerationOptions = {}
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.withTransientCreateRetry(
      'generate',
      () => this.generateSongs(
        prompt,
        false,
        undefined,
        undefined,
        make_instrumental,
        model,
        wait_audio,
        undefined,
        options
      )
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    options: GenerationOptions = {}
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.withTransientCreateRetry(
      'custom_generate',
      () => this.generateSongs(
        prompt,
        true,
        tags,
        title,
        make_instrumental,
        model,
        wait_audio,
        negative_tags,
        options
      )
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    options: GenerationOptions = {},
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    const requestedModel = (model || DEFAULT_MODEL || '').trim();
    const useLatestModel = ['v5.5', 'chirp-fenix'].includes(requestedModel.toLowerCase());
    const effectiveModel = useLatestModel ? 'chirp-fenix' : requestedModel;
    const explicitUsePersona = typeof options.use_persona === 'boolean' ? options.use_persona : undefined;
    const usePersona =
      !make_instrumental &&
      (explicitUsePersona === true ||
        Boolean(options.persona_id) ||
        (explicitUsePersona !== false && DEFAULT_USE_PERSONA));
    const effectiveTask =
      task ??
      options.task ??
      (useLatestModel && usePersona && !make_instrumental ? DEFAULT_TASK : undefined);
    const latestPersonaId =
      useLatestModel && usePersona && !make_instrumental
        ? options.persona_id || DEFAULT_PERSONA_ID || await this.getLatestModelPersonaId()
        : undefined;
    const payload: any = {
      make_instrumental: make_instrumental,
      mv: effectiveModel,
      prompt: '',
      generation_type: 'TEXT',
      continue_at: continue_at,
      continue_clip_id: continue_clip_id,
      task: effectiveTask,
      token: await this.getCaptcha()
    };
    if (useLatestModel) {
      payload.uses_latest_model = true;
      payload.control_sliders = { audio_weight: 1 };
      if (latestPersonaId)
        payload.persona_id = latestPersonaId;
    }
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            model: requestedModel,
            effectiveModel,
            useLatestModel,
            usePersona,
            effectiveTask,
            latestPersonaId,
            defaultUsePersona: DEFAULT_USE_PERSONA,
            defaultPersonaName: DEFAULT_PERSONA_NAME,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            options,
            payload: {
              ...payload,
              token: payload.token ? '<redacted>' : payload.token,
            }
          },
          null,
          2
        )
    );
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    const songIds = response.data.clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean,
    options: GenerationOptions = {}
  ): Promise<AudioInfo[]> {
    return this.withTransientCreateRetry(
      'extend_audio',
      () => this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, options, 'extend', audioId, continueAt)
    );
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  private async getLatestModelPersonaId(): Promise<string | undefined> {
    if (this.latestPersonaId)
      return this.latestPersonaId;

    try {
      const response = await this.client.get(`${SunoApi.BASE_URL}/api/feed/v2`, {
        timeout: 10000
      });
      const clips = response.data?.clips || [];
      const latestFenix = clips.find((clip: any) =>
        clip?.model_name === 'chirp-fenix' &&
        clip?.metadata?.persona_id &&
        clip?.metadata?.task === 'vox'
      );
      if (latestFenix?.metadata?.persona_id) {
        this.latestPersonaId = latestFenix.metadata.persona_id;
        return this.latestPersonaId;
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to resolve latest-model persona_id'
      );
    }

    return undefined;
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};
