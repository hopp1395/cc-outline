import { vi } from "vitest";

// The viewer asks npm and GitHub at its start (setting updateMode); tests stay offline.
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
