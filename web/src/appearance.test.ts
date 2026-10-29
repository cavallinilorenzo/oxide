// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  activeTheme,
  DEFAULT_APPEARANCE,
  getAppearance,
  parseThemePack,
  saveAppearance,
  terminalAppearance,
} from "./appearance";
beforeEach(() => {
  saveAppearance(structuredClone(DEFAULT_APPEARANCE));
});
it("applies a selected JSON theme across UI and terminal and persists separate font families", () => {
  const themeJson = JSON.stringify({
    name: "Custom",
    themes: [
      {
        name: "Paper",
        appearance: "light",
        style: {
          background: "#fafafa",
          text: "#202020",
          "terminal.background": "#eeeeee",
          "terminal.foreground": "#111111",
          syntax: { keyword: { color: "#334455", font_style: "italic" } },
        },
      },
    ],
  });
  saveAppearance({
    ...getAppearance(),
    themeJson,
    themeName: "Paper",
    fonts: {
      ui: "Inter",
      chat: "Arial",
      code: "Consolas",
      terminal: "Cascadia Code",
    },
  });
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe(
    "#fafafa",
  );
  expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
    "Consolas",
  );
  expect(terminalAppearance().theme.background).toBe("#eeeeee");
  expect(activeTheme().appearance).toBe("light");
  expect(
    JSON.parse(localStorage.getItem("oxide:appearance:v1")!).fonts.chat,
  ).toBe("Arial");
});
it("rejects malformed or unsafe theme values and keeps the previous appearance", () => {
  const before = getAppearance();
  expect(() => saveAppearance({ ...before, themeJson: "{broken" })).toThrow();
  expect(getAppearance()).toEqual(before);
  expect(() =>
    parseThemePack(
      JSON.stringify({
        name: "Bad",
        themes: [
          {
            name: "Bad",
            appearance: "dark",
            style: { background: "url(https://example.com/a)" },
          },
        ],
      }),
    ),
  ).toThrow(/hex color/);
  expect(() =>
    parseThemePack(
      JSON.stringify({
        name: "Bad",
        themes: [
          {
            name: "Bad",
            appearance: "dark",
            style: { syntax: { keyword: { color: "#nope" } } },
          },
        ],
      }),
    ),
  ).toThrow(/syntax color/);
});

it("applies size and weight to each area and preserves legacy appearance settings", () => {
  const old = { ...getAppearance(), typography: undefined };
  saveAppearance(old);
  expect(terminalAppearance()).toMatchObject({ fontSize: 13, fontWeight: 400 });
  const typography = structuredClone(DEFAULT_APPEARANCE.typography!);
  typography.terminal = { size: 18, weight: 700 };
  typography.chat = { size: 16, weight: 500 };
  saveAppearance({ ...old, typography });
  expect(terminalAppearance()).toMatchObject({ fontSize: 18, fontWeight: 700 });
  expect(document.documentElement.style.getPropertyValue("--font-chat-size")).toBe("16px");
  expect(() => saveAppearance({ ...old, typography: { ...typography, ui: { size: 200, weight: 400 } } })).toThrow(/Font sizes/);
  expect(terminalAppearance().fontSize).toBe(18);
});
