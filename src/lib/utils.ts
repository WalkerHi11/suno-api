import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

/**
 * Waits for an hCaptcha image requests and then waits for all of them to end
 * @param page
 * @param signal `const controller = new AbortController(); controller.status`
 * @returns {Promise<void>} 
 */
const CAPTCHA_FRAME_SELECTOR =
  'iframe[title*="hCaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenge-platform"]';

async function captchaFrameVisible(page: Page): Promise<boolean> {
  const frames = page.locator(CAPTCHA_FRAME_SELECTOR);
  const count = await frames.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const frame = frames.nth(i);
    if (!await frame.isVisible().catch(() => false))
      continue;
    const box = await frame.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0)
      return true;
  }
  return false;
}

export const waitForRequests = (page: Page, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const isCaptchaRequest = (urlString: string): boolean => {
      try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        const pathname = url.pathname.toLowerCase();
        if (hostname.includes("hcaptcha"))
          return true;
        if (hostname.includes("challenge-platform"))
          return true;
        if (hostname.endsWith(".suno.com") && hostname.startsWith("hcaptcha-"))
          return true;
        if (hostname.endsWith(".suno.com") && pathname.includes("/api/challenge/"))
          return true;
        return false;
      } catch {
        return false;
      }
    };
    let timeoutHandle: NodeJS.Timeout | null = null;
    let initialTimeout: NodeJS.Timeout | null = null;
    let domPollHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestOccurred = false;
    let settled = false;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
      if (initialTimeout)
        clearTimeout(initialTimeout);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (domPollHandle)
        clearInterval(domPollHandle);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve();
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      reject(err);
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          finishResolve();
        }, 1000); // 1 second of no requests
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (isCaptchaRequest(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
        if (initialTimeout) {
          clearTimeout(initialTimeout);
          initialTimeout = null;
        }
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (isCaptchaRequest(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    // Wait for an hCaptcha request (configurable, default 2 minutes)
    const initialWaitMs = Number.parseInt(process.env.CAPTCHA_INITIAL_WAIT_MS || '', 10) || 120000;
    initialTimeout = setTimeout(() => {
      if (!requestOccurred) {
        finishReject(new Error(`No hCaptcha request occurred within ${initialWaitMs / 1000} seconds.`));
      } else {
        // Start waiting for no hCaptcha requests
        resetTimeout();
      }
    }, initialWaitMs); // Configurable timeout (default 2 minutes)

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);

    // Modern Suno often preloads the captcha iframe/widget before the Create click,
    // so network-only detection can miss a ready challenge.
    domPollHandle = setInterval(() => {
      captchaFrameVisible(page)
        .then((visible) => {
          if (visible)
            finishResolve();
        })
        .catch(() => undefined);
    }, 250);

    captchaFrameVisible(page)
      .then((visible) => {
        if (visible)
          finishResolve();
      })
      .catch(() => undefined);

    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      finishReject(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  }); 
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

type SemaphoreWaiter = {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  timeoutId?: NodeJS.Timeout
}

export class AsyncSemaphore {
  private inUse = 0
  private readonly waiters: SemaphoreWaiter[] = []

  constructor(
    private readonly capacity: number,
    private readonly maxQueue: number = Number.POSITIVE_INFINITY
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`AsyncSemaphore capacity must be > 0 (got ${capacity})`)
    }
  }

  public stats() {
    return { capacity: this.capacity, in_use: this.inUse, queued: this.waiters.length }
  }

  public async acquire(options?: { timeoutMs?: number }): Promise<() => void> {
    const timeoutMs = options?.timeoutMs
    if (this.inUse < this.capacity) {
      this.inUse++
      return () => this.release()
    }

    if (this.waiters.length >= this.maxQueue) {
      throw new Error('Server busy (semaphore queue full). Try again soon.')
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
      }
      if (timeoutMs && timeoutMs > 0) {
        waiter.timeoutId = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter)
          if (idx >= 0) this.waiters.splice(idx, 1)
          reject(new Error(`Timed out waiting for capacity after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  private release() {
    this.inUse = Math.max(0, this.inUse - 1)
    this.drain()
  }

  private drain() {
    if (this.inUse >= this.capacity) return
    const waiter = this.waiters.shift()
    if (!waiter) return
    if (waiter.timeoutId) clearTimeout(waiter.timeoutId)
    this.inUse++
    waiter.resolve(() => this.release())
  }
}
