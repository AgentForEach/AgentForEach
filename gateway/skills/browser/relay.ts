/**
 * AgentForEach Skills Layer — Browser handoff relay
 *
 * The two relay connections a handoff needs, from the realtime provider's
 * relay, on the live-view hub (which has no event handlers), each limited to
 * the one handoff group: the driver's, as a hashed id, and the viewer's, as
 * the user. Each names the other as its peer: a provider that binds a relay
 * connection to its two parties (AppSync Events: one channel each) needs
 * it, and returns a connection descriptor with each URL.
 */

import { getRealtimeRelay } from "../../websocket/providers/index.js";
import { handoffDriverUserId, type HandoffRelay } from "./handler.js";

export function handoffRelay(hub: string): HandoffRelay {
  return {
    async issue(viewerUserId, group, ttlMinutes) {
      const relay = await getRealtimeRelay();
      if (!relay) throw new Error("real-time messaging isn't configured");
      const driverUserId = handoffDriverUserId(viewerUserId);
      const [driver, viewer] = await Promise.all([
        relay.groupAccess({ hub, userId: driverUserId, peerUserId: viewerUserId, group, ttlMinutes }),
        relay.groupAccess({ hub, userId: viewerUserId, peerUserId: driverUserId, group, ttlMinutes }),
      ]);
      return {
        driverUrl: driver.url,
        viewerUrl: viewer.url,
        ...(driver.descriptor ? { driver: driver.descriptor } : {}),
        ...(viewer.descriptor ? { viewer: viewer.descriptor } : {}),
      };
    },
  };
}
