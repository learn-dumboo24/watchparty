# WatchTogether

Watch anything together (Netflix, Prime, Hotstar, YouTube, any site with a video player) with synced play, pause and seek, plus a camera and mic call.

```
watchparty/
├── server/
│   ├── index.js          relay server + serves the call page (only dependency: ws)
│   └── public/call.html  the video call page (plain WebRTC)
├── extension/
│   ├── manifest.json
│   ├── sync.js           play/pause/seek sync on any site
│   └── netflix.js        Netflix-safe seeking
└── render.yaml           one-click deploy config for Render
```

## 1. Deploy the server (once, about 10 minutes)

1. Push this whole `watchparty` folder to a new GitHub repo.
2. On render.com: **New → Blueprint**, pick the repo. It reads `render.yaml` and sets everything up.
3. When it's live you get a URL like `https://watchparty-xxxx.onrender.com`. That's your watch party link.

The free plan sleeps after 15 idle minutes. The first visit after that takes up to a minute to wake it.

## 2. Load the extension (both of you, once)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension` folder.

For your partner: zip the `extension` folder and send it. They unzip it and do the same two steps.

## 3. Every movie night

1. Open your Render URL. It creates a room and takes you to its call page.
2. Click **Copy**, send the link to your partner, and both click **Join call**.
3. Both open the movie in another tab, start the same title, and click **👥 Sync this tab** on the right edge of the page.
4. Optional: click **⧉ Float over movie** on the call page to keep both cameras on top of the fullscreen movie.

Use earphones, otherwise the movie audio leaks into your mic.

The call page checklist shows each step as done: partner in the call, extension detected, both movie tabs synced.

## Badge states

| Badge | Meaning |
|---|---|
| 👥 Sync this tab | Not syncing. Click to start |
| ⏳ Waiting for partner | You're in, partner isn't |
| ⏳ Partner hasn't synced their tab | Partner is in the call but hasn't clicked their badge |
| 💚 Synced | Working. It fades so it doesn't distract |
| ▶ Partner pressed play: click here | Chrome blocked autoplay. One click fixes it |
| ⚠ Partner is on a different video | Different episode or title (Netflix and YouTube) |

Click the badge while synced to stop syncing that tab.

## If the cameras won't connect

Movie sync goes through the server and always works. The camera call goes directly between your laptops, and some networks (Jio, many college and office Wi-Fi networks) block that. The fix is a TURN relay:

1. Sign up free at metered.ca (20 GB of relay a month) and create a TURN app.
2. Copy its credentials URL: `https://<yourapp>.metered.live/api/v1/turn/credentials?apiKey=<key>`
3. In Render: your service → **Environment** → set `TURN_CREDENTIALS_URL` to that URL. Render redeploys on its own.

## Run locally (for testing)

```bash
cd server
npm install
npm start
```

Open http://localhost:8080 in two different Chrome profiles, each with the extension loaded.

## Known limits

- Fullscreen on sites that make the `<video>` itself fullscreen hides the badge. Sync keeps working.
- Different ads for each person (Prime, Hotstar) break sync during the ad. It recovers on the next play or pause.
- If you both act within half a second of each other, the second action can be ignored. Just press it again.
