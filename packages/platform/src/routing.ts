/**
 * Route matching for hosts that receive raw requests (a Worker's `fetch`, a
 * Node server, a Lambda function URL). Azure does its own matching; this
 * reproduces its rules so every host routes the same table the same way:
 *
 * - Paths compare case-insensitively, segment by segment; a trailing slash is
 *   ignored.
 * - `{name}` matches one non-empty segment; `{*name}` matches the rest of the
 *   path (possibly empty) and may only be the last segment.
 * - Only routes that accept the request's method are considered.
 * - When several routes match, the most specific wins: more literal segments
 *   first, then fewer catch-alls.
 */

import type { RouteDef } from "./host.js";

export interface RouteMatch<R extends Pick<RouteDef, "route" | "methods"> = RouteDef> {
  route: R;
  /** Decoded values for the route's `{name}` / `{*name}` segments. */
  params: Record<string, string>;
}

interface CompiledSegment {
  kind: "literal" | "param" | "rest";
  value: string;
}

function compile(route: string): CompiledSegment[] {
  const parts = route.replace(/^\/+|\/+$/g, "").split("/").filter((p) => p.length > 0);
  return parts.map((part, i) => {
    const m = /^\{(\*)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part);
    if (!m) return { kind: "literal", value: part.toLowerCase() };
    if (m[1]) {
      if (i !== parts.length - 1) throw new Error(`Catch-all segment must be last in route "${route}"`);
      return { kind: "rest", value: m[2] };
    }
    return { kind: "param", value: m[2] };
  });
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function tryMatch(segments: CompiledSegment[], pathParts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "rest") {
      params[seg.value] = pathParts.slice(i).map(decode).join("/");
      return params;
    }
    const part = pathParts[i];
    if (part === undefined) return null;
    if (seg.kind === "literal") {
      if (decode(part).toLowerCase() !== seg.value) return null;
    } else {
      params[seg.value] = decode(part);
    }
  }
  return pathParts.length === segments.length ? params : null;
}

function specificity(segments: CompiledSegment[]): [number, number] {
  let literals = 0;
  let rests = 0;
  for (const s of segments) {
    if (s.kind === "literal") literals++;
    else if (s.kind === "rest") rests++;
  }
  return [literals, -rests];
}

/**
 * Find the route for a method and path. `path` is the URL pathname (with or
 * without a leading slash, still percent-encoded). Returns null when no route
 * accepts it; hosts answer 404.
 */
export function matchRoute<R extends Pick<RouteDef, "route" | "methods">>(
  routes: readonly R[],
  method: string,
  path: string,
): RouteMatch<R> | null {
  const upper = method.toUpperCase();
  const pathParts = path.replace(/^\/+|\/+$/g, "").split("/").filter((p) => p.length > 0);
  let best: { match: RouteMatch<R>; score: [number, number] } | null = null;
  for (const route of routes) {
    if (!route.methods.some((m) => m === upper)) continue;
    const segments = compile(route.route);
    const params = tryMatch(segments, pathParts);
    if (!params) continue;
    const score = specificity(segments);
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
      best = { match: { route, params }, score };
    }
  }
  return best?.match ?? null;
}
