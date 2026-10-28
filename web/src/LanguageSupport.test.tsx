// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { LanguageSupportNotice } from "./LanguageSupport";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  clearMocks();
  localStorage.clear();
});
it("offers support on first use and downloads only after Install is clicked", async () => {
  const install = vi.fn();
  let installed = false;
  const changed = vi.fn();
  window.addEventListener("oxide-language-tools-changed", changed, {
    once: true,
  });
  mockIPC((command) => {
    if (command === "language_tools")
      return [{ language: "cpp", name: "C/C++ · clangd", installed }];
    if (command === "install_language_support") {
      install();
      installed = true;
      return { installed: true };
    }
    return null;
  });
  await act(async () =>
    root.render(
      <LanguageSupportNotice language="cpp" onConfigure={() => {}} />,
    ),
  );
  expect(host.textContent).toContain("support is available");
  expect(install).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".primary")!.click(),
  );
  expect(install).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(
    host.querySelector('[aria-label="Language support available"]'),
  ).toBeNull();
});
it("allows Later without installing and remembers it", async () => {
  mockIPC((command) =>
    command === "language_tools"
      ? [{ language: "python", name: "Python", installed: false }]
      : null,
  );
  await act(async () =>
    root.render(
      <LanguageSupportNotice language="python" onConfigure={() => {}} />,
    ),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Set up language support later"]',
      )!
      .click(),
  );
  expect(localStorage.getItem("oxide:language-dismissed:python")).toBe("true");
  expect(host.textContent).toBe("");
});
