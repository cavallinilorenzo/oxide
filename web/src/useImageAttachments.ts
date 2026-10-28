import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "./bindings";
import {
  clipboardImages,
  IMAGE_EXTENSIONS,
  normalizeImage,
} from "./imageInput";
interface ImageAttachment {
  path: string;
  previewUrl: string;
  name: string;
}
export function useImageAttachments({
  enabled,
  visible,
  busy,
  context,
}: {
  enabled: boolean;
  visible: boolean;
  busy: boolean;
  context: string;
}) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const records = useRef(new Map<string, ImageAttachment>());
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [imageContext,setImageContext]=useState(context);
  if(imageContext!==context){setImageContext(context);setImages([]);setLoading(0);setError(null);}
  const remove = (paths: string[]) => {
    for (const path of paths) {
      const image = records.current.get(path);
      if (image) URL.revokeObjectURL(image.previewUrl);
      records.current.delete(path);
    }
    setImages([...records.current.values()]);
  };
  useEffect(() => {
    const stamp=++generation.current;
    const owned=records.current;
    return () => {
      generation.current=stamp+1;
      for (const image of owned.values())
        URL.revokeObjectURL(image.previewUrl);
      owned.clear();
    };
  }, [context]);
  async function addImage(source: File) {
    if (!enabled || busy) {
      setError(
        busy
          ? "Wait for the current operation before adding images."
          : "This Provider cannot accept image attachments.",
      );
      return;
    }
    const captured = generation.current;
    setLoading((value) => value + 1);
    setError(null);
    try {
      const file = await normalizeImage(source);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const saved = await commands.saveAttachment(
        bytes,
        IMAGE_EXTENSIONS[file.type],
      );
      if (saved.status === "error") throw new Error(saved.error.message);
      if (captured !== generation.current) return;
      const image = {
        path: saved.data,
        previewUrl: URL.createObjectURL(file),
        name: file.name || "Clipboard image",
      };
      records.current.set(image.path, image);
      setImages([...records.current.values()]);
    } catch (error) {
      if (captured === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (captured === generation.current) setLoading((value) => value - 1);
    }
  }
  async function addPath(path: string) {
    const captured = generation.current;
    setLoading((value) => value + 1);
    try {
      const saved = await commands.importAttachment(path);
      if (saved.status === "error") throw new Error(saved.error.message);
      const read = await commands.readAttachment(saved.data);
      if (read.status === "error") throw new Error(read.error.message);
      if (captured !== generation.current) return;
      const extension = saved.data.split(".").pop();
      const mime =
        Object.entries(IMAGE_EXTENSIONS).find(
          ([, ext]) => ext === extension,
        )?.[0] ?? "image/png";
      const file = new File(
        [new Uint8Array(read.data)],
        path.split(/[\\/]/).pop() ?? "Dropped image",
        { type: mime },
      );
      if (mime === "image/bmp") await addImage(file);
      else {
        const image = {
          path: saved.data,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
        };
        records.current.set(image.path, image);
        setImages([...records.current.values()]);
      }
    } catch (error) {
      if (captured === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (captured === generation.current) setLoading((value) => value - 1);
    }
  }
  const handlers = useRef({ enabled, visible, busy, addImage, addPath });
  useLayoutEffect(() => {
    handlers.current = { enabled, visible, busy, addImage, addPath };
  });
  useEffect(() => {
    const root = () =>
      dropRef.current?.closest<HTMLElement>(".chat-frame") ?? dropRef.current;
    const inside = (event: DragEvent) => {
      const el = root();
      return !!el && event.target instanceof Node && el.contains(event.target);
    };
    const over = (event: DragEvent) => {
      if (
        !handlers.current.visible ||
        !inside(event) ||
        !event.dataTransfer?.types.includes("Files")
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        handlers.current.enabled && !handlers.current.busy ? "copy" : "none";
      setDropping(handlers.current.enabled && !handlers.current.busy);
    };
    const leave = (event: DragEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        root()?.contains(event.relatedTarget)
      )
        return;
      setDropping(false);
    };
    const drop = (event: DragEvent) => {
      setDropping(false);
      if (
        !handlers.current.visible ||
        !inside(event) ||
        !event.dataTransfer?.files.length
      )
        return;
      event.preventDefault();
      if (!handlers.current.enabled || handlers.current.busy) {
        setError("This Provider cannot accept images right now.");
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      for (const file of files) void handlers.current.addImage(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    let active = true;
    let stop: (() => void) | undefined;
    try {
      void getCurrentWindow()
        .onDragDropEvent(({ payload }) => {
          if (!handlers.current.visible) return;
          if (payload.type === "leave") {
            setDropping(false);
            return;
          }
          const el = root();
          const box = el?.getBoundingClientRect();
          const x = payload.position.x / window.devicePixelRatio;
          const y = payload.position.y / window.devicePixelRatio;
          const within =
            !!box &&
            x >= box.left &&
            x <= box.right &&
            y >= box.top &&
            y <= box.bottom;
          if (payload.type === "enter" || payload.type === "over") {
            setDropping(
              within && handlers.current.enabled && !handlers.current.busy,
            );
            return;
          }
          setDropping(false);
          if (payload.type === "drop" && within) {
            if (!handlers.current.enabled || handlers.current.busy) {
              setError("This Provider cannot accept images right now.");
              return;
            }
            for (const path of payload.paths)
              void handlers.current.addPath(path);
          }
        })
        .then((unlisten) => {
          if (active) stop = unlisten;
          else unlisten();
        })
        .catch(() => {});
    } catch {
      /* Browser tests use DOM file drops. */
    }
    return () => {
      active = false;
      stop?.();
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const handlePaste = (event: ClipboardEvent) => {
    const files = clipboardImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) void addImage(file);
  };
  return {
    images,
    addImage,
    removeImage: (path: string) => remove([path]),
    clearSent: remove,
    handlePaste,
    dropRef,
    dropping,
    loading,
    error,
  };
}
