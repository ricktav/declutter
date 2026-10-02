# Flow for iOS (V1)

Native SwiftUI app for the Declutter **Flow** loop: **Snap → Sort → Act → Gone**. It talks to the HomeBase server already in this repo. It is not a WebView wrapper of `/flow/`.

Product words: **Thing**, **Place**, **Photo**, **Decision**, **Lens**.

Gone is `items.status = "archived"` on a Thing that already has a Decision. There is no second gone status. Rejected detections (`verificationStatus = rejected`) never appear.

This folder was written on Linux. **Open it on a Mac.** This environment has no Xcode and no iOS Simulator.

## Open in Xcode

1. On a Mac: `git clone` this repo (or pull this branch).
2. Open `ios/DeclutterFlow/DeclutterFlow.xcodeproj` in Xcode 15+ (iOS 17 SDK).
3. Select the **DeclutterFlow** target → **Signing & Capabilities**.
4. Choose your **Team**. Xcode will create a unique bundle id if `com.homebase.DeclutterFlow` is taken — that is fine.
5. Pick an iPhone simulator or a plugged-in device.
6. Run (⌘R).

## Point the app at your LAN server

1. Start HomeBase on the machine that already runs it:

   ```bash
   npm run dev
   ```

   Default: `http://<that-machine>:3000` (Workbench at `/`, Flow at `/flow/`).

2. In the iOS app, tap the gear → **Settings**.
3. **Server base URL** — example: `http://10.50.0.10:3000` (no trailing path).
4. **APP_TOKEN** — the same value as `APP_TOKEN` in the server `.env`. Stored in the Keychain, sent as `Authorization: Bearer`.
5. Tap **Save and ping**. You should see “Server is up.”

If `APP_TOKEN` is unset on the server, leave the token field empty. Only do that on a trusted LAN.

## Simulator vs device

| | Simulator | Physical iPhone |
|---|---|---|
| Photo library | Works (Photos picker) | Works |
| Camera | Not available — use the library | Works (back camera) |
| LAN HTTP | Works if the Mac can reach the server | Needs Local Network permission |

## ATS, local network, cleartext HTTP

HomeBase on a LAN is usually **http://** not https. iOS blocks cleartext by default.

This target sets:

- `NSAllowsArbitraryLoads = YES` so a configurable LAN IP (for example `10.50.0.10`) works. `NSAllowsLocalNetworking` alone is **not** enough for a numeric LAN address.
- `NSAllowsLocalNetworking = YES`
- `NSLocalNetworkUsageDescription` — iOS 14+ local-network prompt
- Camera and photo-library usage strings

If you put HomeBase behind HTTPS (or Tailscale Serve), you can tighten ATS later. Prefer HTTPS if the server is reachable off your LAN.

The phone and the server must be on the same network (or a VPN). A `localhost` URL on the phone is the phone itself, not your Mac.

## What V1 covers

| Tab | Behavior |
|---|---|
| **Settings** | Base URL + APP_TOKEN (Keychain) + `ping` |
| **Snap** | Camera / library → `POST /api/upload` (`file`, `scope=inbox`) → `inbox.create`. Optional Place (“where you are”). Notes and links. |
| **Sort** | Inbox Photos: AI triage, name / kind, Place, file (`inbox.acceptMany`) or dismiss. Check (`items.setVerification`). Place (`items.update`). |
| **Act** | Keep / sell / donate / toss / later (`items.setDecision`). Sell list / donate box / toss run. **Gone** (`items.setArchived`). Later returns after 7 days. |
| **Find** | Search Things by name, Place, or kind. Decision on the Thing sheet. `rooms.get` when a room plan exists. |

Tabs match web Flow. Photos load through `attachments.url` plus the same Bearer token (the relative `/uploads/…` URL is not enough on its own).

## Known gaps vs web Flow

- No Computer-lab **Lens** (backup checks, lab attributes, `items.listRelations`).
- No Sell-list money fields (`sell.ask_price`, channel, listed/sold dates) — Decision and Gone only.
- No floor-scan import, GeoJSON thumb, or room-plan pin canvas (`ItemRoomPreview` / annotate).
- No Workbench, wiki, ideas, or kanban.
- No “open in Workbench” in-app browser.
- App icon is a placeholder (empty 1024pt slot).

## API it uses (unchanged)

tRPC: `ping`, `inbox.list`, `inbox.create`, `inbox.triage`, `inbox.acceptMany`, `inbox.dismiss`, `items.listAll`, `items.update`, `items.setVerification`, `items.setArchived`, `items.setDecision`, `items.patchAttributes` (client ready, unused in V1 UI), `houses.list`, `areas.list`, `map.listLocations`, `attachments.url`, `rooms.get`.

HTTP: `POST /api/upload`.

Do not edit `flow/` or `src/flow/` from this app.
