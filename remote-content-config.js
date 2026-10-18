/* Build-time trust boundary. Set this once when producing an official build.
   It is deliberately not read from page, local, or sync storage. */
window.MCxRemoteContentConfig = Object.freeze({
  feedUrl: 'https://annoucement.moss104088.workers.dev/content'
});
