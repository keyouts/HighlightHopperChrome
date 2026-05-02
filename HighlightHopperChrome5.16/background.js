const ext = typeof browser !== "undefined" ? browser : chrome;

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openOptions") {
    ext.runtime.openOptionsPage();
  }
});
