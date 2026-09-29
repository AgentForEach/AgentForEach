/**
 * AgentForEach Identity Module — Link authorization
 *
 * Who may create an identity link directly through the API. Everyone else
 * links a channel account by pairing: the code sent from the channel is the
 * proof that the caller controls that account.
 */

import { isAdmin } from "../auth/roles.js";
import type { AuthContext } from "../auth/types.js";

export type LinkCreateBody = {
  channel?: string;
  channelUserId?: string;
  userId?: string;
};

export type LinkCreateDecision =
  | { ok: true; targetUserId: string; channel: string; channelUserId: string }
  | { ok: false; status: 400 | 403; error: string };

export function authorizeLinkCreate(
  auth: AuthContext,
  body: LinkCreateBody,
): LinkCreateDecision {
  const channel = body.channel?.trim().toLowerCase();
  const channelUserId = body.channelUserId?.trim();
  if (!channel || !channelUserId) {
    return { ok: false, status: 400, error: "channel and channelUserId are required" };
  }
  if (!isAdmin(auth)) {
    return {
      ok: false,
      status: 403,
      error:
        "Linking a channel account directly requires the admin role. " +
        "Use POST /api/identity/pair and send the code from the channel instead.",
    };
  }
  return {
    ok: true,
    targetUserId: body.userId?.trim() || auth.userId,
    channel,
    channelUserId,
  };
}
