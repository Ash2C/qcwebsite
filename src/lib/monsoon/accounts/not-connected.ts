/** A pipeline with no database yet, or a customer with no Claude key. Re-exported by account.ts. */
export class NotConnected extends Error {
  constructor(what: string) {
    super(`${what} is not connected`);
    this.name = "NotConnected";
  }
}

/**
 * The free trial's key is failing (refused, or out of credit), so a client on trial cannot use the
 * AI features for now. Nothing about the key is in here: the message is all there is to say.
 */
export class TrialPaused extends Error {
  constructor() {
    super("The free trial is paused. Add your own Claude key, or try again later.");
    this.name = "TrialPaused";
  }
}
