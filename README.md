# 🏓 Ping Pong Party

**▶ Play now: https://pierrre1618.github.io/ping-pong-party/** (create a room, send the link to your friends)

A cartoon **"around the table"** ping pong game (*la tournante*) for **2–10 players** in the browser.
Everybody has **2 lives**. After you hit the ball you must **get to the other end of the table**
(run around it, or belly-slide under it!) and wait for your next turn. Miss, or hit it out, and you lose a heart.
The last player standing wins. When only two players are left, it becomes a **final duel**.

- **Camera behind you**: the ball comes towards you, so it is easy to read. Press **C** for the whole-table view or first person.
- **Click to hit**: put your paddle on the 🎯 and click. The swing happens when the ball arrives.
- **Slap!** Somebody standing in your way gets a 👋 sign: right click knocks them aside (they get dizzy for a moment).
  The player whose turn it is can't be slapped.
- **3D cartoon graphics** with three.js (toon shading, outlines, particles, confetti)
- **Real ball physics**: gravity, drag, Magnus effect, and spin that grips the table on the bounce
  (topspin kicks, backspin stops dead or even comes back, sidespin curves)
- **Peer-to-peer multiplayer** over WebRTC (PeerJS). No game server: the host's browser runs the match.
- **Bots** to fill the room or to practice alone
- Static files only, so it hosts for free on **GitHub Pages**

## Difficulty

The host picks it in the menu or lobby, and it applies to everyone in the room.

| | 🙂 Easy (default) | 😎 Normal | 🔥 Pro |
| --- | --- | --- | --- |
| Ball speed | slow & floaty | medium | fast |
| Paddle | big | medium | small |
| Aim assist | shots always land on the table | near-misses corrected | none (too hard = OUT) |
| Hit before the bounce | allowed | allowed | not allowed |
| 🎯 "hit here" target | yes | yes | no |
| Auto-walk (play with the mouse only) | yes | no | no |
| Run to the other end by yourself after your hit | yes (+ auto slide) | yes | yes |
| Click reach | big | medium | small |
| Bots | clumsy | decent | sharp |

A 4-step tutorial shows the first time you play. Reopen it anytime with the ❓ button.
During the game, a speech bubble ("RUN to 🟣!", "You're NEXT!", "CLICK to hit! 🎯") and a small hint
next to the mouse pointer ("CLICK!", "👋 RIGHT CLICK = SLAP!") always tell you what to do.

## Controls

| Action | Input |
| --- | --- |
| Move the paddle | **Mouse** |
| Hit the ball | **Left click** when the ball arrives (or hold it: you swing as soon as the ball is in reach) |
| Slap a player in your way | **Right click** (or **E** / **F**) |
| Backspin chop | **Right click** on the ball when nobody is around to slap |
| Run | **WASD**, **ZQSD** (AZERTY) or **arrow keys**, relative to the camera (W = forward) |
| Slide under the table to change ends | **Space** at the end of the table (otherwise Space = dash) |
| Aim | Swing **sideways** while you click (otherwise the shot goes away from the next player) |
| Power | Swing **forward** while you click. High balls are **smashed** automatically |
| Curve ball | Swing in an **arc** and touch the ball |
| Change camera | **C** or the 🎥 button: behind you · whole table · first person |

Your paddle height adjusts to the ball automatically. After your hit you get turbo shoes 🏃💨 until you
reach the other end. Ghosts (eliminated players) watch the whole table.

## Run it locally

ES modules don't load from `file://`, so serve the folder with any static server:

```bash
cd pingpong
python -m http.server 8080
# then open http://localhost:8080
```

(`npx serve .` works too.)

To try multiplayer on one computer, open the game in **two separate browser windows**, side by side
(not two tabs of the same window: browsers pause hidden tabs).
Click **Create a room** in one window and **Join** with the code in the other.

## How joining works (no server)

1. The host clicks **Create a room** and gets a 5-letter code (and an invite link).
2. Friends paste the code into **Join**, or simply open the invite link.
3. The host can add bots, then presses **START**.

The free public PeerJS broker (`0.peerjs.com`) is only used for the initial handshake, which
exchanges the WebRTC connection info for the room code. After that, all game traffic flows
directly between browsers. The host acts as referee: it validates hits, decides who loses a life and
rotates the turn queues. Each player detects their own hits locally, so hitting feels lag-free.

Note: a few very strict networks (some corporate or university NATs) block direct WebRTC connections.
Those would need a TURN relay server, which this project doesn't include.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, open **Settings → Pages → Build and deployment**, choose **Deploy from a branch**,
   then pick `main` and `/ (root)`.
3. Your game will be live at `https://<user>.github.io/<repo>/`. Share the room code or invite link.

No build step is needed: three.js and PeerJS are vendored in `vendor/`.

## Project layout

```
index.html        UI screens (menu, lobby, HUD, game over)
style.css         cartoon UI styling
js/constants.js   fixed values (table size, physics, lives…)
js/tune.js        difficulty levels (Easy / Normal / Pro)
js/physics.js     deterministic ball simulation + shot model (auto-arc, spin)
js/game.js        rules, turn queues, host referee, network sync, interpolation
js/bots.js        bot AI + path finding around the table
js/render.js      three.js scene, characters, ball, effects
js/net.js         PeerJS host/guest wrappers
js/audio.js       synthesized sound effects (no audio files)
js/ui.js          HUD and DOM helpers
js/main.js        menu/lobby/session flow, input, main loop
vendor/           three.js r160 and PeerJS 1.5.4
```
