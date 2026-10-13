import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { ALL_AVATAR_PRESETS, AVATAR_MAX_WIDTH, AVATAR_PRESETS, avatarLead, avatarMeaning, avatarOf, avatarProblem, emojiInputHint, isAvatarSetting } from "../src/avatar.js";

describe("avatar presets", () => {
  it("offers eight in each group, each with a meaning, none twice", () => {
    expect(AVATAR_PRESETS.map((g) => [g.group, g.presets.length])).toEqual([
      ["ASCII", 8],
      ["Emoji", 8],
      ["Combos", 8],
    ]);
    expect(new Set(ALL_AVATAR_PRESETS.map((p) => p.avatar)).size).toBe(ALL_AVATAR_PRESETS.length);
    for (const p of ALL_AVATAR_PRESETS) {
      expect(p.meaning).not.toBe("");
      expect(avatarProblem(p.avatar)).toBeUndefined();
    }
  });

  it("uses emojis two columns wide, without variation selectors or joiners", () => {
    for (const p of AVATAR_PRESETS.filter((g) => g.group !== "ASCII").flatMap((g) => g.presets)) {
      expect(p.avatar).not.toMatch(/[\u200d\ufe0f]/);
      expect(stringWidth(p.avatar)).toBe([...p.avatar].length * 2);
    }
    for (const p of AVATAR_PRESETS[0].presets) expect(p.avatar).toMatch(/^[\x21-\x7e]+$/);
  });

  it("tells a preset's meaning", () => {
    expect(avatarMeaning("🦊")).toBe("fox");
    expect(avatarMeaning("JH")).toBeUndefined();
  });
});

describe("avatar values", () => {
  it("allows up to six columns of anything but control characters", () => {
    expect(avatarProblem("👾👾👾")).toBeUndefined();
    expect(avatarProblem("abcdef")).toBeUndefined();
    expect(avatarProblem("")).toBeUndefined();
    expect(avatarProblem("abcdefg")).toContain(`${AVATAR_MAX_WIDTH} columns`);
    expect(avatarProblem("🦊🦊🦊🦊")).toContain("columns");
    expect(avatarProblem("a\u0007")).toContain("control");
  });

  it("trims, and makes an empty or invalid value none", () => {
    expect(avatarOf("  JH ")).toBe("JH");
    expect(avatarOf("")).toBeUndefined();
    expect(avatarOf("   ")).toBeUndefined();
    expect(avatarOf("toolong")).toBeUndefined();
    expect(avatarOf(3)).toBeUndefined();
  });

  it("stores only the empty default or a trimmed avatar", () => {
    expect(isAvatarSetting("")).toBe(true);
    expect(isAvatarSetting("🦊")).toBe(true);
    expect(isAvatarSetting(" 🦊")).toBe(false);
    expect(isAvatarSetting("1234567")).toBe(false);
    expect(isAvatarSetting(false)).toBe(false);
  });

  it("puts a space on each side of an avatar, as a badge, and leaves the cco as it is", () => {
    expect(avatarLead(undefined)).toBe("cco");
    expect(avatarLead("🦊")).toBe(" 🦊 ");
    expect(avatarLead("J")).toBe(" J ");
    expect(avatarLead("<><")).toBe(" <>< ");
    expect(avatarLead("👾👾👾")).toBe(" 👾👾👾 ");
  });

  it("tells how to type emojis on each system", () => {
    expect(emojiInputHint("win32")).toContain("`Win+.`");
    expect(emojiInputHint("darwin")).toContain("`Ctrl+Cmd+Space`");
    expect(emojiInputHint("linux")).toContain("emoji picker");
  });
});
