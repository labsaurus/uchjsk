export class CrawlError extends Error {
  constructor(message, props = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, props);
  }
}

/** Server signalled an anti-bot challenge / access denial. Never retried, never bypassed. */
export class BlockedError extends CrawlError {}

/** Retries exhausted (or Retry-After longer than we're willing to wait). */
export class RetryExhaustedError extends CrawlError {}

/** robots.txt disallows this URL. */
export class DisallowedError extends CrawlError {}

export class ResponseTooLargeError extends CrawlError {}
