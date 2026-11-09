import { join } from "node:path";
import { readAccount } from "../account.js";
import { claudeDir, readJson } from "../transcript/locate.js";

/** Why the remote API cannot be asked, or what it answered. */
export type RemoteErrorKind =
  /** No `.credentials.json` with a login in the config folder. */
  | "no-login"
  /** The login's access token has run out; Claude Code renews it, cco never does. */
  | "expired"
  /** The login lacks the scope asked for (`user:sessions:claude_code`, `user:profile`). */
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

/** The scope of the login that may read the account's profile, its plan's usage windows among it. */
export const PROFILE_SCOPE = "user:profile";

/**
 * The access token Claude Code keeps in the config folder `dir`, if it has `scope`: read from the file each time and
 * never written or renewed, since Claude Code rotates it. Throws a `RemoteError` that says what is missing.
 */
export function readToken(dir = claudeDir(), now = Date.now(), scope = SESSIONS_SCOPE): string {
  const oauth = readJson<Credentials>(join(dir, ".credentials.json"))?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token === "") throw new RemoteError("no-login", "no login found in .credentials.json (start Claude Code and run /login)");
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now) throw new RemoteError("expired", "the login has expired: start Claude Code or run /login");
  if (!Array.isArray(oauth?.scopes) || !oauth.scopes.includes(scope)) throw new RemoteError("no-scope", `the login lacks the scope ${scope}: run /login`);
  return token;
}

/** The login the remote sessions need (`readToken` with `SESSIONS_SCOPE`) and the organisation they are asked for. */
export function readLogin(dir = claudeDir(), now = Date.now()): RemoteLogin {
  const token = readToken(dir, now);
  const org = readAccount(dir)?.organizationId;
  if (!org) throw new RemoteError("no-org", "no organisation found in .claude.json");
  return { token, org };
}
