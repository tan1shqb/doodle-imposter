# Doodle Imposter

A draw-and-bluff party game for 3 to 8 players on their own phones. Everyone
gets the same word to draw, except the imposter, who only gets a vague hint.
Draw, reveal, vote, find the imposter.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

To play on phones, put them on the same Wi-Fi and open `http://<your-computer-ip>:3000`.
For a real hotel or event, deploy it (below) so guests can use a normal link and QR code.

```bash
npm test           # full multiplayer simulation against the real server
npm run test:ui    # phone-sized browser tests (drawing, lobby, reveal, timers)
```

The browser tests use Playwright's Chromium. If it is not installed yet, run
`npx playwright install chromium` once. `UI_SHOTS=some/folder npm run test:ui` also saves
screenshots of the key screens.

## How a round works

1. One player creates a room (private, or listed in "Public lobbies"). Others join with the
   5-character code, a QR code or link, or by picking a public lobby.
2. The host starts. The server picks the imposter and a prompt. Normal players see the category
   and word; the imposter only sees a hint.
3. Everyone draws for 45 seconds. Unsubmitted drawings are submitted automatically at zero.
4. All drawings are revealed at once. Players discuss, then vote (45 seconds).
5. If the imposter is the single most-voted player they are caught, but get one guess at the word.
   A right guess steals the win. A tie, no votes, or voting for the wrong person lets the imposter win.

## Rules the server enforces

- Each player is only sent their own secret. Other drawings are not sent until the reveal.
- The imposter's identity is not sent until the results.
- Rejoining uses a private token kept in the browser, so refreshing or a locked phone does not
  drop you. If the host leaves, host passes to the next player in join order.
- Anyone can join with the code while a round is going. They wait on a "next round" screen, see
  nothing of the current round (no word, hint or drawings), and play from the next round.
- On the reveal screen players can tap reactions on each drawing. Everyone sees the counts, never
  who reacted. Tap again to take a reaction back.
- The host can remove players from the lobby before the game starts (the × next to their name).
- A player who taps Leave, or stays disconnected for 30 seconds mid-round (`DI_DROP_MS`), is removed
  from the game. Votes for them are cleared so those players vote again.
- If the imposter leaves, the round is cancelled back to the lobby. If fewer than 3 players are left,
  the game ends and everyone returns to the home screen.

## Sound and vibration

Short synthesised beeps (no audio files) for the 10-second warning, the last five seconds of the
drawing and voting timers, time running out, and the reveal, with matching vibration on phones that
support it (not iPhones). The speaker button in the lobby turns both off, and the choice is
remembered. On iPhone the silent switch mutes the sounds.

## Deploy

It is a single Node process with WebSockets, so use any host that keeps a Node server running
(Render, Railway, Fly.io, a VPS). Serverless hosts such as Vercel functions will not work for this.
Use HTTPS so the share/copy buttons work on phones. `PORT` is read from the environment and
`/healthz` is available for health checks.

Rooms live in memory. Restarting the server ends all games, and one instance holds all rooms.

## Settings

Timers can be changed with environment variables (milliseconds): `DI_READY_MS` (20000),
`DI_DRAW_MS` (45000), `DI_REVEAL_MS` (60000), `DI_VOTE_MS` (45000), `DI_GUESS_MS` (20000), `DI_DROP_MS` (30000).

## Files

- `server.js` game rooms, rules, and WebSocket protocol
- `prompts.js` the word list (`{ category, word, hint }`); add your own here
- `public/` the phone UI (`index.html`, `style.css`, `app.js`) and the QR library in `vendor/`
- `test/sim.js` multiplayer simulation
