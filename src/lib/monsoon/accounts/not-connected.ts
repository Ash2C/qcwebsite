/** A pipeline with no database yet, or a customer with no Claude key. Re-exported by account.ts. */
export class NotConnected extends Error {
  constructor(what: string) {
    super(`${what} is not connected`);
    this.name = "NotConnected";
  }
}
