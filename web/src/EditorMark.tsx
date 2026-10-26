import { CodeIcon } from "@primer/octicons-react";
import {
  siCursor,
  siIntellijidea,
  siPycharm,
  siSublimetext,
  siVscodium,
  siWebstorm,
  siWindsurf,
  siXcode,
} from "simple-icons";

type Mark = { title: string; path: string; color: string };

const MARKS: Record<string, Mark | undefined> = {
  "com.vscodium": { title: "VSCodium", path: siVscodium.path, color: "#2f80ed" },
  "com.todesktop.230313mzl4w4u92": { title: "Cursor", path: siCursor.path, color: "#e6e8ee" },
  "com.exafunction.windsurf": { title: "Windsurf", path: siWindsurf.path, color: "#e6e8ee" },
  "com.sublimetext.4": { title: "Sublime Text", path: siSublimetext.path, color: "#ff9800" },
  "com.apple.dt.Xcode": { title: "Xcode", path: siXcode.path, color: "#147efb" },
  "com.jetbrains.intellij": { title: "IntelliJ IDEA", path: siIntellijidea.path, color: "#e6e8ee" },
  "com.jetbrains.WebStorm": { title: "WebStorm", path: siWebstorm.path, color: "#e6e8ee" },
  "com.jetbrains.pycharm": { title: "PyCharm", path: siPycharm.path, color: "#e6e8ee" },
};

/** An editor's brand mark (Simple Icons), or a generic code Octicon where Simple Icons has none. */
export function EditorMark({ bundleId, size = 16 }: { bundleId: string; size?: number }) {
  const mark = MARKS[bundleId];
  if (!mark) return <span className="provider-mark" aria-hidden="true"><CodeIcon size={size} /></span>;
  return (
    <svg className="provider-mark" aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={mark.color}>
      <path d={mark.path} />
    </svg>
  );
}
