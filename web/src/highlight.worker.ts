import type { HighlightRequest, HighlightResponse } from "./highlightClient";
import { createHighlightService } from "./highlightService";

// Creating the service starts compiling the common grammars right away.
const service = createHighlightService();

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage: (response: HighlightResponse) => void;
};

scope.onmessage = async ({ data: { id, code, lang } }) => {
  try {
    scope.postMessage({ id, html: await service.highlight(code, lang) });
  } catch (e) {
    scope.postMessage({ id, error: String(e) });
  }
};
