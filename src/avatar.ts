import stringWidth from "string-width";

/** The widest an avatar may be, in terminal columns: three emojis. */
export const AVATAR_MAX_WIDTH = 6;
/** What the top bar shows without an avatar, and the width every lead keeps at least. */
export const DEFAULT_AVATAR = "cco";

export interface AvatarPreset {
  avatar: string;
  meaning: string;
}

/**
 * The avatars on offer, by group. The emojis are single code points that terminals draw two columns wide (no
 * variation selector, no joined sequences), so their width is the same everywhere.
 */
export const AVATAR_PRESETS: { group: string; presets: AvatarPreset[] }[] = [
  {
    group: "ASCII",
    presets: [
      { avatar: "(^_^)", meaning: "happy" },
      { avatar: "[o_o]", meaning: "robot" },
      { avatar: "=^.^=", meaning: "cat" },
      { avatar: "<><", meaning: "fish" },
      { avatar: "C|_|", meaning: "coffee" },
      { avatar: "\\o/", meaning: "cheers" },
      { avatar: "</>", meaning: "code" },
      { avatar: "$>_", meaning: "prompt" },
    ],
  },
  {
    group: "Emoji",
    presets: [
      { avatar: "🦊", meaning: "fox" },
      { avatar: "🐙", meaning: "octopus" },
      { avatar: "🤖", meaning: "robot" },
      { avatar: "👾", meaning: "alien" },
      { avatar: "🚀", meaning: "rocket" },
      { avatar: "🔥", meaning: "fire" },
      { avatar: "💎", meaning: "gem" },
      { avatar: "🍀", meaning: "clover" },
    ],
  },
  {
    group: "Combos",
    presets: [
      { avatar: "☕💻", meaning: "coder" },
      { avatar: "🚀🌙", meaning: "moon shot" },
      { avatar: "🤖🧠", meaning: "AI" },
      { avatar: "🐛🔨", meaning: "debugging" },
      { avatar: "🦊🌲", meaning: "fox in the woods" },
      { avatar: "🎸🤘", meaning: "rock" },
      { avatar: "🐙🌊🐚", meaning: "deep sea" },
      { avatar: "👾👾👾", meaning: "space invaders" },
    ],
  },
];

/** Every preset, in the order the dialog lists them. */
export const ALL_AVATAR_PRESETS: AvatarPreset[] = AVATAR_PRESETS.flatMap((g) => g.presets);

/** Why `text` cannot be an avatar, or undefined when it can (after trimming; empty means the default). */
export function avatarProblem(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return "no control characters";
  if (stringWidth(value) > AVATAR_MAX_WIDTH) return `at most ${AVATAR_MAX_WIDTH} columns (an emoji takes 2)`;
  return undefined;
}

/** `value` as an avatar: trimmed, or undefined where it is none (empty, not text, or not allowed). */
export function avatarOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && avatarProblem(text) === undefined ? text : undefined;
}

/** Whether `value` may be stored as the setting: empty (the default) or an avatar as it is stored, trimmed. */
export const isAvatarSetting = (value: unknown): boolean => value === "" || (typeof value === "string" && avatarOf(value) === value);

/** The top bar's lead: "cco", or the avatar as a badge with a space on each side, as in the Settings view's list. */
export function avatarLead(avatar: string | undefined): string {
  return avatar ? ` ${avatar} ` : DEFAULT_AVATAR;
}

/** The meaning of a preset avatar, if it is one. */
export const avatarMeaning = (avatar: string): string | undefined => ALL_AVATAR_PRESETS.find((p) => p.avatar === avatar)?.meaning;

/** How to type an emoji on this system, for the dialog and the setting's details. */
export function emojiInputHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "`Win+.` opens the emoji panel";
  if (platform === "darwin") return "`Ctrl+Cmd+Space` opens the emoji picker";
  return "your desktop's emoji picker types emojis (GNOME: `Ctrl+.` in many apps)";
}
