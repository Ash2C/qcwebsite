// Who may see and answer sign-up requests: the key person of the customer `quantcloud`, nobody
// else. The Requests route and the "can approve" answer on "Your page" both ask here, so the screen
// can never offer what the route refuses.
import type { Account } from "./account";

export const OWNER_CODE = "quantcloud";

export function canApprove(account: { customer: Pick<Account["customer"], "code">; canChangeKey: boolean }): boolean {
  return account.customer.code === OWNER_CODE && account.canChangeKey === true;
}
