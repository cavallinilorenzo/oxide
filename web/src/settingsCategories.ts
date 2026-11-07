/** The categories shown in Settings' left-hand navigation. */
export const SETTINGS_CATEGORIES = [
  { id: "general", label: "General", sections: ["general"] },
  { id: "providers", label: "Providers", sections: ["providers"] },
  { id: "appearance", label: "Appearance", sections: ["appearance"] },
  { id: "dictation", label: "Voice & Dictation", sections: ["dictation"] },
  { id: "developer", label: "Developer Tools", sections: ["github", "language"] },
  { id: "shortcuts", label: "Shortcuts", sections: ["shortcuts"] },
  { id: "updates", label: "Updates", sections: ["updates"] },
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];
export type SettingsCategoryId = SettingsCategory["id"];

/** Map a category id or one of its section ids (e.g. "language") to the category. */
export function settingsCategoryFor(section: string | null | undefined): SettingsCategoryId | null {
  if (!section) return null;
  const match = SETTINGS_CATEGORIES.find(
    (category) =>
      category.id === section ||
      (category.sections as readonly string[]).includes(section),
  );
  return match?.id ?? null;
}
