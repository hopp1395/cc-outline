import { join } from "node:path";
import { readAccount } from "../account.js";
import { L } from "../i18n/index.js";
import { claudeDir, readJson } from "../transcript/locate.js";

/** Why the remote API cannot be asked, or what it answered. */
export type RemoteErrorKind =
  /** No `.credentials.json` with a login in the config folder. */
  | "no-login"
  /** The login's access token has run out; Claude Code renews it, cco never does. */
  | "expired"
  /** The login lacks the scope `user:sessions:claude_code`. */
  | "no-scope"
  /** `.claude.json` names no organisation. */
  | "no-org"
  | "unauthorized"
  | "forbidden"
  | "rate-limit"
  /** The certificate of the connection is not trusted (a company proxy). */
  | "tls"
  | "offline"
  | "server"
  /** The answer is not what the interface was known to send. */
  | "format";

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** What the remote API needs of a login: the access token and the organisation it is asked for. */
export interface RemoteLogin {
  token: string;
  org: string;
}

/** The scope of the login that may list and read Claude Code sessions. */
export const SESSIONS_SCOPE = "user:sessions:claude_code";

interface Credentials {
  claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown };
}

/**
 * The login Claude Code keeps in the config folder `dir`: read from the file each time and never written or
 * renewed, since Claude Code rotates it. Throws a `RemoteError` that says what is missing.
 */
export function readLogin(dir = claudeDir(), now = Date.now()): RemoteLogin {
  const oauth = readJson<Credentials>(join(dir, ".credentials.json"))?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token === "") throw new RemoteError("no-login", L().remote.noLogin);
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now) throw new RemoteError("expired", L().remote.expired);
  if (!Array.isArray(oauth?.scopes) || !oauth.scopes.includes(SESSIONS_SCOPE)) throw new RemoteError("no-scope", L().remote.noScope(SESSIONS_SCOPE));
  const org = readAccount(dir)?.organizationId;
  if (!org) throw new RemoteError("no-org", L().remote.noOrg);
  return { token, org };
}
