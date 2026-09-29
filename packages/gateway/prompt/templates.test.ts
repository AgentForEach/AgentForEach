import test from "node:test";
import assert from "node:assert/strict";

import { renderDocumentData, DEFAULT_TEMPLATES } from "./templates.js";

// ============================================================================
// AGENTS renderer
// ============================================================================

test("renderDocumentData AGENTS renders all sections", () => {
  const result = renderDocumentData("AGENTS", DEFAULT_TEMPLATES.AGENTS);

  assert.match(result, /## How Your Context Works/);
  assert.match(result, /## Group Chat Behavior/);
  // safetyRules, communicationStyle, memoryGuidance removed (covered by structural sections)
  assert.doesNotMatch(result, /## Safety Rules/);
  assert.doesNotMatch(result, /## Communication Style/);
  assert.doesNotMatch(result, /## Memory Management/);
});

test("renderDocumentData AGENTS renders custom sections", () => {
  const result = renderDocumentData("AGENTS", {
    contextGuide: "Guide text",
    custom: { "My Section": "My content here" },
  });

  assert.match(result, /## How Your Context Works/);
  assert.match(result, /Guide text/);
  assert.match(result, /## My Section/);
  assert.match(result, /My content here/);
});

test("renderDocumentData AGENTS with empty data returns empty string", () => {
  const result = renderDocumentData("AGENTS", {});
  assert.equal(result, "");
});

// ============================================================================
// SOUL renderer
// ============================================================================

test("renderDocumentData SOUL renders all sections", () => {
  const result = renderDocumentData("SOUL", DEFAULT_TEMPLATES.SOUL);

  assert.match(result, /## Core Truths/);
  assert.match(result, /## Boundaries/);
  assert.match(result, /## Vibe/);
  assert.match(result, /## Continuity/);
});

test("renderDocumentData SOUL with custom sections", () => {
  const result = renderDocumentData("SOUL", {
    vibe: "Playful",
    custom: { "Special Rule": "Always use puns" },
  });

  assert.match(result, /## Vibe/);
  assert.match(result, /Playful/);
  assert.match(result, /## Special Rule/);
  assert.match(result, /Always use puns/);
});

// ============================================================================
// USER renderer
// ============================================================================

test("renderDocumentData USER renders profile fields", () => {
  const result = renderDocumentData("USER", {
    name: "Alice",
    timezone: "America/New_York",
    language: "English",
    communicationStyle: "concise",
    interests: ["TypeScript", "cooking"],
    workContext: "Software developer",
    notes: "Prefers dark mode",
  });

  assert.match(result, /\*\*Name:\*\* Alice/);
  assert.match(result, /\*\*Timezone:\*\* America\/New_York/);
  assert.match(result, /\*\*Language:\*\* English/);
  assert.match(result, /\*\*Communication style:\*\* concise/);
  assert.match(result, /\*\*Interests:\*\* TypeScript, cooking/);
  assert.match(result, /\*\*Work context:\*\* Software developer/);
  assert.match(result, /## Notes/);
  assert.match(result, /Prefers dark mode/);
});

test("renderDocumentData USER with empty data returns empty string", () => {
  const result = renderDocumentData("USER", {});
  assert.equal(result, "");
});

// ============================================================================
// IDENTITY renderer
// ============================================================================

test("renderDocumentData IDENTITY renders all fields", () => {
  const result = renderDocumentData("IDENTITY", DEFAULT_TEMPLATES.IDENTITY);

  assert.match(result, /\*\*Name:\*\* Assistant/);
  assert.match(result, /\*\*Emoji:\*\*/);
  assert.match(result, /\*\*Creature:\*\* Assistant/);
  assert.match(result, /\*\*Vibe:\*\*/);
  assert.match(result, /\*\*Role:\*\* Personal AI assistant/);
});

test("renderDocumentData IDENTITY with quirks", () => {
  const result = renderDocumentData("IDENTITY", {
    name: "Aria",
    quirks: ["loves puns", "says 'beep boop'"],
  });

  assert.match(result, /\*\*Quirks:\*\* loves puns, says 'beep boop'/);
});

// ============================================================================
// TOOLS renderer
// ============================================================================

test("renderDocumentData TOOLS renders notes and integrations", () => {
  const result = renderDocumentData("TOOLS", {
    notes: "General tool notes",
    integrations: {
      calendar: "Use for scheduling",
      jira: "Project tracking",
    },
  });

  assert.match(result, /General tool notes/);
  assert.match(result, /## Integrations/);
  assert.match(result, /### calendar/);
  assert.match(result, /Use for scheduling/);
  assert.match(result, /### jira/);
  assert.match(result, /Project tracking/);
});

test("renderDocumentData TOOLS with only notes", () => {
  const result = renderDocumentData("TOOLS", { notes: "Just notes" });

  assert.match(result, /Just notes/);
  assert.doesNotMatch(result, /## Integrations/);
});

// ============================================================================
// HEARTBEAT renderer
// ============================================================================

test("renderDocumentData HEARTBEAT renders numbered task list", () => {
  const result = renderDocumentData("HEARTBEAT", {
    tasks: ["Check reminders", "Review emails", "Update status"],
  });

  assert.match(result, /1\. Check reminders/);
  assert.match(result, /2\. Review emails/);
  assert.match(result, /3\. Update status/);
});

test("renderDocumentData HEARTBEAT with empty tasks returns empty string", () => {
  const result = renderDocumentData("HEARTBEAT", { tasks: [] });
  assert.equal(result, "");
});

test("renderDocumentData HEARTBEAT with no tasks returns empty string", () => {
  const result = renderDocumentData("HEARTBEAT", {});
  assert.equal(result, "");
});

// ============================================================================
// BOOTSTRAP renderer
// ============================================================================

test("renderDocumentData BOOTSTRAP renders onboarding flow", () => {
  const result = renderDocumentData("BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP);

  assert.match(result, /Welcome! This is your first conversation\./);
  assert.match(result, /## Onboarding Flow/);
  assert.match(result, /1\. Introduce yourself/);
  assert.match(result, /## Important/);
  assert.match(result, /Be warm and welcoming/);
});

// ============================================================================
// MEMORY renderer
// ============================================================================

test("renderDocumentData MEMORY renders all memory sections", () => {
  const result = renderDocumentData("MEMORY", {
    userPreferences: ["Prefers dark mode", "Likes concise replies"],
    keyFacts: ["Works at Acme Corp", "Uses TypeScript daily"],
    patterns: ["Usually asks about code in the morning"],
  });

  assert.match(result, /## User Preferences/);
  assert.match(result, /- Prefers dark mode/);
  assert.match(result, /- Likes concise replies/);
  assert.match(result, /## Key Facts/);
  assert.match(result, /- Works at Acme Corp/);
  assert.match(result, /## Patterns & Context/);
  assert.match(result, /- Usually asks about code/);
});

test("renderDocumentData MEMORY with empty arrays returns empty string", () => {
  const result = renderDocumentData("MEMORY", DEFAULT_TEMPLATES.MEMORY);
  assert.equal(result, "");
});

test("renderDocumentData MEMORY with partial data renders only populated sections", () => {
  const result = renderDocumentData("MEMORY", {
    keyFacts: ["Important fact"],
    userPreferences: [],
    patterns: [],
  });

  assert.match(result, /## Key Facts/);
  assert.match(result, /- Important fact/);
  assert.doesNotMatch(result, /## User Preferences/);
  assert.doesNotMatch(result, /## Patterns/);
});

// ============================================================================
// Unknown / edge cases
// ============================================================================

test("renderDocumentData with unknown type returns empty string", () => {
  const result = renderDocumentData("UNKNOWN" as any, { foo: "bar" });
  assert.equal(result, "");
});

test("renderDocumentData handles non-object data gracefully", () => {
  const result = renderDocumentData("AGENTS", null as any);
  assert.equal(result, "");
});

test("renderDocumentData handles array data gracefully", () => {
  const result = renderDocumentData("AGENTS", ["not", "an", "object"] as any);
  assert.equal(result, "");
});
