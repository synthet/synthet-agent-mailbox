/** Rejected by mailbox rules. Safe to show to the calling agent. */
export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

/** Failure talking to the remote mailbox. `retryable` means the host may be offline. */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}
