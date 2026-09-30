/**
 * Functions that run inside the page (passed to page.evaluate, so each must be
 * self-contained). They tag the elements a person could act on with
 * data-afe-ref="eN" and describe them in a compact text list, so the model
 * reads the page and acts by ref instead of guessing selectors.
 */

/**
 * Tag interactive elements and describe the page.
 *
 * Refs are stable: an element keeps the ref it was given for as long as it is
 * in the document, and new elements get new numbers, so a ref from an earlier
 * snapshot either still means the same element or is gone (an error), never a
 * different element. Every visible element is tagged; `query` searches all of
 * them, and the list shows elements in view first, up to `maxList`.
 *
 * @param {{ maxList: number, query?: string }} opts
 */
export function snapshotInPage(opts) {
  const ATTR = "data-afe-ref";
  const MAX_TAGGED = 5000;
  if (typeof window.__afeNextRef !== "number") window.__afeNextRef = 1;

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "switch", "combobox", "textbox", "searchbox",
    "slider", "spinbutton", "treeitem",
  ]);
  const TYPED_INPUTS = new Set(["date", "time", "datetime-local", "month", "week", "email", "tel", "url", "number", "color"]);
  const clean = (s, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    return !el.closest("[aria-hidden='true'], [inert]");
  }

  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "file") return "fileinput";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "generic";
  }

  function name(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && clean(label.textContent)) return clean(label.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping !== el && clean(wrapping.textContent)) return clean(wrapping.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes(el.type) && el.value) return clean(el.value);
    // A <select>'s text is all its options; they're listed separately.
    const text = tag === "select" ? "" : clean(el.innerText);
    if (text) return text;
    return clean(
      el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.getAttribute("alt") ??
        el.querySelector("img[alt]")?.getAttribute("alt") ?? el.getAttribute("name") ?? "",
    );
  }

  /** Where a link goes, short: the path on this site, or host + path elsewhere. */
  function shortHref(raw) {
    try {
      const u = new URL(raw, location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      const path = (u.pathname + (u.search ? u.search.slice(0, 25) : "")).slice(0, 60);
      return u.host === location.host ? path : `${u.host}${path}`.slice(0, 70);
    } catch {
      return "";
    }
  }

  function state(el) {
    const parts = [];
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (TYPED_INPUTS.has(type)) parts.push(`type=${type}`);
      if (type === "checkbox" || type === "radio") {
        if (el.checked) parts.push("checked");
      } else if (type === "file") {
        if (el.files?.length) parts.push(`files=${el.files.length}`);
      } else if (!["button", "submit", "reset", "image"].includes(type)) {
        // Never echo a password or card number back into the model's context.
        const secret = type === "password" || /cc-|card/i.test(el.getAttribute("autocomplete") ?? "");
        const value = secret ? (el.value ? "••••" : "") : clean(el.value, 60);
        parts.push(`value="${value}"`);
      }
    } else if (tag === "select") {
      parts.push(`value="${clean(el.selectedOptions[0]?.textContent ?? "", 60)}"`);
      const options = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 30));
      parts.push(`options=[${options.join(" | ")}${el.options.length > 12 ? " | …" : ""}]`);
    } else if (el.isContentEditable) {
      parts.push(`value="${clean(el.innerText, 60)}"`);
    }
    if (el.getAttribute("aria-checked") === "true") parts.push("checked");
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (tag === "a" && el.getAttribute("href")) {
      const href = shortHref(el.getAttribute("href"));
      if (href) parts.push(`→ ${href}`);
    }
    return parts.join(" ");
  }

  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[contenteditable='']", "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])",
    ...[...INTERACTIVE_ROLES].map((r) => `[role='${r}']`),
  ].join(",");

  const inView = [];
  const offscreen = [];
  let scanned = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (scanned++ >= MAX_TAGGED) break;
    if (!visible(el)) continue;
    let ref = el.getAttribute(ATTR);
    if (!ref) {
      ref = `e${window.__afeNextRef++}`;
      el.setAttribute(ATTR, ref);
    }
    const rect = el.getBoundingClientRect();
    const seen = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    const line = [`[${ref}]`, role(el), JSON.stringify(name(el)), state(el), seen ? "" : "(offscreen)"]
      .filter(Boolean)
      .join(" ");
    (seen ? inView : offscreen).push(line);
  }
  const all = [...inView, ...offscreen];
  const tokens = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  // Match what the element is, not its ref: "4999" shouldn't find [e4999].
  const described = (line) => line.slice(line.indexOf("]") + 1).toLowerCase();
  const matching = tokens.length ? all.filter((line) => tokens.every((t) => described(line).includes(t))) : all;

  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .filter(visible)
    .slice(0, 20)
    .map((h) => `${"#".repeat(Number(h.tagName[1]))} ${clean(h.textContent, 100)}`)
    .filter((h) => h.trim().length > 2);

  // Validation errors, "added to cart" and similar live messages aren't controls, but the agent needs them.
  const messages = [...document.querySelectorAll("[role=alert], [role=status], [aria-live=assertive], [aria-live=polite]")]
    .filter(visible)
    .map((m) => clean(m.innerText, 150))
    .filter(Boolean)
    .slice(0, 5);

  const frames = [...document.querySelectorAll("iframe")].filter(visible).length;
  const body = document.body?.innerText ?? "";
  const scrollable = Math.max(document.documentElement.scrollHeight - innerHeight, 0);
  return {
    title: clean(document.title, 200),
    url: location.href.slice(0, 500),
    scroll: scrollable ? Math.round((scrollY / scrollable) * 100) : 0,
    pageHeight: document.documentElement.scrollHeight,
    headings,
    elements: matching.slice(0, opts.maxList),
    total: all.length,
    matched: matching.length,
    messages,
    frames,
    // For bot-wall detection, and shown when a page has almost nothing to act on.
    lead: clean(body, 600),
  };
}

/** Readable text of the page (or of the first match of `selector`). */
export function textInPage(selector) {
  const root =
    (selector && document.querySelector(selector)) ||
    document.querySelector("main, article, [role=main]") ||
    document.body;
  return root ? root.innerText.replace(/\n{3,}/g, "\n\n").trim() : "";
}

/** Draw (or remove) numbered labels on tagged elements in view, for a labelled screenshot. */
export function labelsInPage(show) {
  const ID = "afe-labels";
  document.getElementById(ID)?.remove();
  if (!show) return 0;
  const layer = document.createElement("div");
  layer.id = ID;
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  let n = 0;
  for (const el of document.querySelectorAll("[data-afe-ref]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #F29A1F`;
    const tag = document.createElement("span");
    tag.textContent = el.getAttribute("data-afe-ref");
    tag.style.cssText = "position:absolute;left:0;top:-14px;font:bold 11px/14px monospace;background:#F29A1F;color:#151827;padding:0 3px";
    box.appendChild(tag);
    layer.appendChild(box);
    n++;
  }
  document.documentElement.appendChild(layer);
  return n;
}
