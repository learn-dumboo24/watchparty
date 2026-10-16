// WatchTogether: netflix.js
// Runs in Netflix's own JavaScript world ("world": "MAIN" in the manifest), so it can
// reach Netflix's player. Needed because setting video.currentTime directly makes
// Netflix crash with error M7375. sync.js asks for seeks through a page event.

document.addEventListener('wt-netflix', (e) => {
  let cmd;
  try { cmd = JSON.parse(e.detail); } catch { return; }

  try {
    const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const sessionId = api.getAllPlayerSessionIds().find((id) => id.startsWith('watch'))
      || api.getAllPlayerSessionIds()[0];
    const player = api.getVideoPlayerBySessionId(sessionId);

    if (cmd.action === 'seek') player.seek(Math.round(cmd.t * 1000)); // Netflix uses milliseconds
  } catch (err) {
    console.warn('[WatchTogether] Netflix player not ready', err);
  }
});
