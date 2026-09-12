Real responses captured from youtube.com on 2026-09-11, unauthenticated, no API key.
The parser suite runs against these; it must never touch the network.

| file | what it is |
|---|---|
| rss.mkbhd.xml | channel feed, 15 entries, all normal videos |
| rss.mrbeast-with-shorts.xml | channel feed whose 2nd and 4th entries (5mU6SRS2Bxo, LiH-P4rSkLI) are shorts |
| resolve_url.mkbhd.json | @handle -> channel id |
| browse.videos-tab.mrbeast.json | Videos tab; the channel header parse runs on this. Video ids sit under contentId |
| player.live.json | a live stream: isLive true, lengthSeconds "0", liveBroadcastDetails present |
| player.normal-video.json | a normal video, captured with NO ?key= parameter |
| player.premiere.synthetic.json | SYNTHETIC, not captured — upcoming premiere player response, derived from player.live.json |
