import type { BriefOutput, OutlineOutput, VoiceProfile } from "@me/shared";

/** Small, valid inputs shared by the pipeline tests. Not used at runtime. */
export const testVoice: VoiceProfile = {
  name: "Test Voice",
  identity_type: "pen_name",
  bio_short: "",
  bio_long: "",
  rules: { perspective: "second person", sentence_length: { min: 6, max: 22 } },
  preferred_terms: ["warm introduction"],
  banned_terms: ["game-changer", "unlock your potential", "em dashes"],
  samples: [],
  language: "en",
};

export const testBrief: BriefOutput = {
  title: "The Weekly Outreach System",
  subtitle: "A 30-minute routine for introverts who need warm introductions",
  promise: "In four weeks you will run a 30-minute weekly outreach routine that produces two warm introductions a month.",
  reader_profile: "Dana, 44, a consultant who lost her biggest client and has never asked anyone for an introduction.",
  positioning: "Comps teach networking events; this book teaches a weekly routine at a desk.",
  frameworks: [
    { name: "The Friday Five", summary: "Five messages sent every Friday." },
    { name: "Warmth Ladder", summary: "Four steps from stranger to referral." },
    { name: "Ask Ledger", summary: "A log of every ask and its result." },
  ],
  tone: "Plain, direct, grade 8 reading level",
  reader_job: "A reader hires this book to run a weekly outreach routine so they can get warm introductions without events.",
  outcome: "A running outreach routine and a list of 40 warm contacts.",
  examples: ["Dana's first Friday Five, sent to five former colleagues", "A plumber who tracked 12 asks in an Ask Ledger"],
};

export const testOutline: OutlineOutput = {
  intro: { promise: "A routine, not an event.", reason_to_keep_reading: "Chapter 1 gets you sending this Friday.", word_target: 1000 },
  chapters: [
    {
      title: "Start With Five",
      goal: "Send your first five messages.",
      points: ["Why five is enough", "Who goes on the first list", "What the first message says"],
      example: "Dana's first Friday Five",
      action_step: "Write five names on a card.",
      word_target: 3000,
      frameworks_introduced: ["The Friday Five"],
      frameworks_used: [],
      transition: "Next, make the messages warmer.",
    },
    {
      title: "Climb the Ladder",
      goal: "Move each contact one rung warmer.",
      points: ["The four rungs", "Signals a contact is ready", "Moving up one rung a week"],
      example: "A contact moved from stranger to referral in six weeks",
      action_step: "Mark each contact's rung.",
      word_target: 3000,
      frameworks_introduced: ["Warmth Ladder"],
      frameworks_used: ["The Friday Five"],
      transition: "Next, track the asks.",
    },
    {
      title: "Keep the Ledger",
      goal: "Track every ask so you see what works.",
      points: ["What goes in the ledger", "Reading the ledger monthly", "When to stop asking someone"],
      example: "A plumber who tracked 12 asks in an Ask Ledger",
      action_step: "Start the ledger with this week's asks.",
      word_target: 3000,
      frameworks_introduced: ["Ask Ledger"],
      frameworks_used: ["Warmth Ladder"],
      transition: "",
    },
  ],
  conclusion: { transformation: "You run the routine every week.", companion_course: "Templates in the course.", word_target: 1000 },
};
