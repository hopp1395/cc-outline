import { describe, expect, it } from "vitest";
import { claudeCommandLine, shellAfter } from "../src/launch.js";

describe("claudeCommandLine", () => {
  it("passes plain arguments as they are", () => {
    expect(claudeCommandLine(["--resume", "6e2a673a-9abc-41a0-ab30-2f2f3cc5219c"])).toBe("claude --resume 6e2a673a-9abc-41a0-ab30-2f2f3cc5219c");
  });

  it("quotes arguments with spaces or characters cmd.exe acts on, doubling quotes inside", () => {
    expect(claudeCommandLine(["--add-dir", "C:\\Program Files\\x", "a&b", 'say "hi"', ""])).toBe('claude --add-dir "C:\\Program Files\\x" "a&b" "say ""hi""" ""');
  });
});

describe("shellAfter", () => {
  it("starts cmd.exe with /k on Windows, which leaves out its banner, and the login shell elsewhere", () => {
    expect(shellAfter("win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toEqual({ command: "C:\\Windows\\system32\\cmd.exe", args: ["/k"] });
    expect(shellAfter("win32", {})).toEqual({ command: "cmd.exe", args: ["/k"] });
    expect(shellAfter("linux", { SHELL: "/bin/zsh" })).toEqual({ command: "/bin/zsh", args: [] });
  });
});
