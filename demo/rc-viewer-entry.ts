// What demo/record-rc-viewer.mjs needs from the viewer, bundled as one module (`npm run demo:rc-viewer`), so the
// settings and the request store it prepares are the ones the viewer reads.
export { RcViewerApp } from "../src/tui/RcViewerApp.js";
export { setOwnSettings } from "../src/settings.js";
export { recordLocalRequest } from "../src/localRequest.js";
