// What we say when a conversation cannot be opened.
//
// The refusal has to explain itself: "already open" on its own reads like a
// bug, and the reader has no way to know that the alternative — opening it
// anyway — is what corrupts the transcript. So every message here states the
// reason, states what will happen if it is ignored, and ends with the two
// ways out.
//
// The wording is English because it is written for the terminal, where the
// rest of the CLI's output is English; the App translates its own copy of the
// same facts.

const FORK_WARNING = [
  "Claude Code keeps a conversation in a single transcript file and does not lock it,",
  "so two processes writing to it at the same time fork and corrupt the history.",
].join(" ");

// The conversation somebody else is sitting in, so we cannot open it too.
export function conversationAlreadyOpenMessage({ holder = null } = {}) {
  const where = holder?.originrouter
    ? "another OriginRouter session"
    : "another terminal";
  return [
    `This conversation is already open in ${where}.`,
    "",
    FORK_WARNING,
    "OriginRouter will not open a conversation that is already running.",
    "",
    "Close that session and run this again, or start a new conversation.",
  ].join("\n");
}

// The conversation the reader asked to switch into is taken, so we left them
// where they were instead of failing.
export function conversationSwitchBlockedMessage({ holder = null } = {}) {
  const where = holder?.originrouter
    ? "another OriginRouter session"
    : "another terminal";
  return [
    `That conversation is already open in ${where}, so OriginRouter stayed in this one.`,
    "",
    FORK_WARNING,
    "",
    "Close that session and switch again, or start a new conversation.",
  ].join("\n");
}
