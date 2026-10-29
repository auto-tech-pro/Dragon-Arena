# Dragon Arena relay (Cloudflare Worker)

Lets two players find each other with a 4-letter room code, from any network.

1. Install Node.js (nodejs.org, the LTS version).
2. Open a terminal in this `relay` folder.
3. Run `npx wrangler login` and approve it in the browser tab that opens.
4. Run `npx wrangler deploy`.
5. It prints an address like `https://dragon-arena-relay.YOURNAME.workers.dev`. Use that in the game under
   LAN Battle > Create/Join online room > Server settings.
