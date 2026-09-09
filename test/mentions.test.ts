import { test } from "node:test";
import assert from "node:assert";
import {
  MentionGate,
  SentIds,
  escapeRegex,
  formatObserved,
  mentionsName,
  stripMention,
  MAX_OBSERVED_CHARS,
} from "../src/mentions.js";
import { stripReplyFallback } from "../src/interfaces/matrix.js";
import { isAddressedTo } from "../src/interfaces/telegram.js";

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

test("mentionsName: matches a standalone name with or without @", () => {
  assert.ok(mentionsName("vega: status?", "vega"));
  assert.ok(mentionsName("hey @vega can you look", "vega"));
  assert.ok(mentionsName("ping vega", "vega"), "trailing position counts");
  assert.ok(mentionsName("VEGA wake up", "vega"), "case-insensitive");
});

test("mentionsName: does not match a name embedded in another word", () => {
  assert.ok(!mentionsName("vegan lunch spot", "vega"));
  assert.ok(!mentionsName("vega-bot is offline", "vega"), "nick chars are word chars on IRC");
  assert.ok(!mentionsName("supervega", "vega"));
});

test("mentionsName: empty name never matches", () => {
  assert.ok(!mentionsName("anything", ""));
  assert.ok(!mentionsName("anything", "   "));
});

test("escapeRegex: regex metacharacters in a nick are literal", () => {
  assert.ok(mentionsName("hi a.b", "a.b"));
  assert.ok(!mentionsName("hi axb", "a.b"), "the dot is not a wildcard");
  assert.equal(escapeRegex("a+b"), "a\\+b");
});

test("stripMention: removes a leading address and inline mentions", () => {
  assert.equal(stripMention("vega: status?", "vega"), "status?");
  assert.equal(stripMention("vega, status?", "vega"), "status?");
  assert.equal(stripMention("hey @vega look at this", "vega"), "hey  look at this".trim());
  assert.equal(stripMention("vega", "vega"), "", "a bare mention strips to nothing");
});

// ---------------------------------------------------------------------------
// Observation buffer
// ---------------------------------------------------------------------------

test("gate: disabled is a passthrough that buffers nothing", () => {
  const gate = new MentionGate(false);
  assert.equal(gate.active, false);
  gate.observe("#ops", "ada", "chatter");
  assert.equal(gate.pending("#ops"), 0, "nothing would ever drain it");
  assert.equal(gate.withContext("#ops", "hello"), "hello");
});

test("gate: observed messages fold into the next addressed turn, oldest first", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "anyone deploying?");
  gate.observe("#ops", "oguz", "I pushed the migration");
  assert.equal(gate.pending("#ops"), 2);

  const folded = gate.withContext("#ops", "did it land?");
  assert.match(folded, /^\[2 messages in this channel you were not addressed in/);
  assert.ok(
    folded.indexOf("ada: anyone deploying?") < folded.indexOf("oguz: I pushed the migration"),
    "chronological order",
  );
  assert.ok(folded.endsWith("did it land?"), "the addressed message comes last");
  assert.equal(gate.pending("#ops"), 0, "buffer is drained");
});

test("gate: buffers are per channel", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "ops chatter");
  gate.observe("#random", "ada", "random chatter");

  const ops = gate.withContext("#ops", "hi");
  assert.match(ops, /ops chatter/);
  assert.ok(!ops.includes("random chatter"), "channels don't leak into each other");
  assert.equal(gate.pending("#random"), 1);
});

test("gate: no context block when nothing was observed", () => {
  const gate = new MentionGate(true);
  assert.equal(gate.withContext("#ops", "hello"), "hello");
});

test("gate: blank messages are not buffered", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "");
  gate.observe("#ops", "ada", "   ");
  assert.equal(gate.pending("#ops"), 0);
});

test("gate: long messages are truncated", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "x".repeat(MAX_OBSERVED_CHARS + 500));
  const folded = gate.withContext("#ops", "hi");
  const line = folded.split("\n").find((l) => l.startsWith("ada: "))!;
  assert.ok(line.length <= MAX_OBSERVED_CHARS + "ada: ".length + 1, "capped");
  assert.ok(line.endsWith("…"), "truncation is visible");
});

test("gate: the buffer is bounded and reports what it dropped", () => {
  const gate = new MentionGate(true, 3);
  for (let i = 1; i <= 6; i++) gate.observe("#ops", "ada", `msg ${i}`);
  assert.equal(gate.pending("#ops"), 3, "only the most recent window is kept");

  const folded = gate.withContext("#ops", "catch me up");
  assert.match(folded, /3 earlier messages not shown/);
  assert.ok(!folded.includes("msg 1"), "oldest dropped");
  assert.match(folded, /msg 4[\s\S]*msg 5[\s\S]*msg 6/);
});

test("gate: a zero-size buffer keeps gating but stores nothing", () => {
  const gate = new MentionGate(true, 0);
  gate.observe("#ops", "ada", "chatter");
  assert.equal(gate.active, true);
  assert.equal(gate.withContext("#ops", "hi"), "hi");
});

test("gate: clear drops a channel's buffer without folding it in", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "chatter");
  gate.clear("#ops");
  assert.equal(gate.withContext("#ops", "hi"), "hi");
});

test("formatObserved: singular wording and fencing", () => {
  const block = formatObserved([{ sender: "ada", text: "hi" }]);
  assert.match(block, /^\[1 message in this channel you were not addressed in/);
  assert.ok(block.endsWith("[end of observed messages]"));
});

// ---------------------------------------------------------------------------
// Sent-id tracking
// ---------------------------------------------------------------------------

test("SentIds: remembers ids and evicts the oldest past the cap", () => {
  const ids = new SentIds(2);
  ids.add("a");
  ids.add("b");
  assert.ok(ids.has("a") && ids.has("b"));
  ids.add("c");
  assert.ok(!ids.has("a"), "oldest evicted");
  assert.ok(ids.has("b") && ids.has("c"));
});

test("SentIds: ignores empty ids and duplicates", () => {
  const ids = new SentIds(2);
  ids.add(undefined);
  ids.add(null);
  ids.add("");
  assert.ok(!ids.has(undefined) && !ids.has(""));
  ids.add("a");
  ids.add("a");
  ids.add("b");
  assert.ok(ids.has("a"), "duplicate add did not consume a slot");
});

// ---------------------------------------------------------------------------
// Matrix reply fallback
// ---------------------------------------------------------------------------

test("stripReplyFallback: drops the quoted fallback, keeps the reply", () => {
  const body = "> <@vega:example.com> the migration is done\n\nthanks!";
  assert.equal(stripReplyFallback(body), "thanks!");
});

test("stripReplyFallback: multi-line quotes and plain bodies", () => {
  assert.equal(
    stripReplyFallback("> <@vega:example.com> line one\n> line two\n\nok"),
    "ok",
  );
  assert.equal(stripReplyFallback("no fallback here"), "no fallback here");
});

// ---------------------------------------------------------------------------
// Telegram addressing
// ---------------------------------------------------------------------------

test("telegram: an @username mention addresses the bot", () => {
  assert.ok(isAddressedTo({ text: "@vega_bot status?" }, 42, "vega_bot"));
  assert.ok(isAddressedTo({ text: "hey @VEGA_BOT" }, 42, "vega_bot"), "case-insensitive");
  assert.ok(isAddressedTo({ caption: "@vega_bot what is this?" }, 42, "vega_bot"), "captions count");
  assert.ok(isAddressedTo({ text: "/status@vega_bot" }, 42, "vega_bot"), "command suffix counts");
});

test("telegram: a bare name or another bot's mention does not", () => {
  assert.ok(!isAddressedTo({ text: "vega_bot status?" }, 42, "vega_bot"), "no @, not a mention");
  assert.ok(!isAddressedTo({ text: "@vega_botswana hi" }, 42, "vega_bot"), "prefix of a longer handle");
  assert.ok(!isAddressedTo({ text: "@other_bot hi" }, 42, "vega_bot"));
  assert.ok(!isAddressedTo({ text: "just chatting" }, 42, "vega_bot"));
});

test("telegram: a reply to the bot's message addresses it", () => {
  assert.ok(isAddressedTo({ text: "thanks", reply_to_message: { from: { id: 42 } } }, 42, "vega_bot"));
  assert.ok(
    !isAddressedTo({ text: "thanks", reply_to_message: { from: { id: 7 } } }, 42, "vega_bot"),
    "a reply to someone else does not",
  );
});

test("telegram: a text_mention entity pointing at the bot addresses it", () => {
  const msg = { text: "Vega look", entities: [{ type: "text_mention", user: { id: 42 } }] };
  assert.ok(isAddressedTo(msg, 42, ""), "works even without a public username");
  assert.ok(!isAddressedTo({ ...msg, entities: [{ type: "text_mention", user: { id: 7 } }] }, 42, ""));
});

test("telegram: with no resolved identity, nothing looks addressed", () => {
  assert.ok(!isAddressedTo({ text: "@vega_bot hi" }, 0, ""));
  assert.ok(!isAddressedTo(undefined, 42, "vega_bot"));
});
