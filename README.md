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
```

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
- If fewer than two players remain mid-round, the round is cancelled back to the lobby.

## Deploy

It is a single Node process with WebSockets, so use any host that keeps a Node server running
(Render, Railway, Fly.io, a VPS). Serverless hosts such as Vercel functions will not work for this.
Use HTTPS so the share/copy buttons work on phones. `PORT` is read from the environment and
`/healthz` is available for health checks.

Rooms live in memory. Restarting the server ends all games, and one instance holds all rooms.

## Settings

Timers can be changed with environment variables (milliseconds): `DI_READY_MS` (20000),
`DI_DRAW_MS` (45000), `DI_REVEAL_MS` (60000), `DI_VOTE_MS` (45000), `DI_GUESS_MS` (20000).

## Files

- `server.js` game rooms, rules, and WebSocket protocol
- `prompts.js` the word list (`{ category, word, hint }`); add your own here
- `public/` the phone UI (`index.html`, `style.css`, `app.js`) and the QR library in `vendor/`
- `test/sim.js` multiplayer simulation
