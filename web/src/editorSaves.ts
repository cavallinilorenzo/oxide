const editors = new Map<string, () => Promise<boolean>>();
export function registerEditorSave(id: string, save: () => Promise<boolean>) {
  editors.set(id, save);
  return () => {
    editors.delete(id);
  };
}
export async function saveAllEditors() {
  const results = await Promise.all(
    [...editors.values()].map((save) => save()),
  );
  return results.every(Boolean);
}
